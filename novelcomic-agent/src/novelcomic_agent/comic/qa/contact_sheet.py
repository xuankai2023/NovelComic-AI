"""Assemble contact-sheet and low-resolution preview bytes from still frames.

Remotion's contact-sheet response is only a frame plan. These helpers turn
decoded stills into a PNG sheet and an uncompressed AVI reel.
"""

from __future__ import annotations

import struct
import zlib

_PNG = b"\x89PNG\r\n\x1a\n"


def encode_png(width: int, height: int, rgb: bytes) -> bytes:
    if width < 1 or height < 1 or len(rgb) != width * height * 3:
        raise ValueError("png frame has the wrong size")
    raw = bytearray()
    stride = width * 3
    for y in range(height):
        raw.append(0)
        raw.extend(rgb[y * stride : (y + 1) * stride])
    return b"".join(
        (
            _PNG,
            _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)),
            _png_chunk(b"IDAT", zlib.compress(bytes(raw), level=9)),
            _png_chunk(b"IEND", b""),
        )
    )


def decode_png(blob: bytes) -> tuple[int, int, bytes]:
    if not blob.startswith(_PNG):
        raise ValueError("contact sheet still is not a png")
    offset = len(_PNG)
    width = height = None
    compressed = bytearray()
    while offset + 8 <= len(blob):
        length = struct.unpack(">I", blob[offset : offset + 4])[0]
        tag = blob[offset + 4 : offset + 8]
        start = offset + 8
        end = start + length
        if end + 4 > len(blob):
            raise ValueError("truncated png")
        payload = blob[start:end]
        expected = zlib.crc32(tag + payload) & 0xFFFFFFFF
        actual = struct.unpack(">I", blob[end : end + 4])[0]
        if expected != actual:
            raise ValueError("png checksum mismatch")
        if tag == b"IHDR":
            width, height, depth, color, interlace = struct.unpack(">IIBBBBB", payload)[0:5]
            if depth != 8 or color not in {2, 6} or interlace != 0:
                raise ValueError("unsupported png")
        elif tag == b"IDAT":
            compressed.extend(payload)
        elif tag == b"IEND":
            break
        offset = end + 4
    if width is None or height is None or not compressed:
        raise ValueError("png is missing image data")
    channels = 4 if color == 6 else 3
    raw = zlib.decompress(bytes(compressed))
    stride = width * channels
    rgb = bytearray()
    cursor = 0
    previous = bytearray(stride)
    for _ in range(height):
        if cursor >= len(raw):
            raise ValueError("png rows are truncated")
        filter_type = raw[cursor]
        cursor += 1
        row = bytearray(raw[cursor : cursor + stride])
        cursor += stride
        if len(row) != stride:
            raise ValueError("png row width mismatch")
        _unfilter(filter_type, row, previous)
        previous = row
        if channels == 4:
            rgb.extend(row[index] for index in range(len(row)) if index % 4 != 3)
        else:
            rgb.extend(row)
    return width, height, bytes(rgb)


def assemble_contact_sheet(stills: list[bytes], *, columns: int = 4, gap: int = 4) -> bytes:
    """Tile still PNGs. The frame-plan JSON is never a valid result."""

    if not stills:
        raise ValueError("contact sheet requires at least one still")
    decoded = [decode_png(still) for still in stills]
    cell_w = max(image[0] for image in decoded)
    cell_h = max(image[1] for image in decoded)
    columns = max(1, min(columns, len(decoded)))
    rows = (len(decoded) + columns - 1) // columns
    width = columns * cell_w + (columns - 1) * gap
    height = rows * cell_h + (rows - 1) * gap
    canvas = bytearray([255]) * (width * height * 3)
    for index, (image_w, image_h, rgb) in enumerate(decoded):
        origin_x = (index % columns) * (cell_w + gap)
        origin_y = (index // columns) * (cell_h + gap)
        for y in range(image_h):
            for x in range(image_w):
                src = (y * image_w + x) * 3
                dst = ((origin_y + y) * width + (origin_x + x)) * 3
                canvas[dst : dst + 3] = rgb[src : src + 3]
    sheet = encode_png(width, height, bytes(canvas))
    if sheet[:1] in {b"{", b"["}:
        raise ValueError("contact sheet was encoded as text")
    return sheet


def write_preview_avi(stills: list[bytes]) -> bytes:
    """Uncompressed RGB AVI. Rebuilding the same stills yields the same bytes."""

    decoded = [decode_png(still) for still in stills]
    if not decoded:
        raise ValueError("preview reel requires at least one still")
    width, height, _rgb = decoded[0]
    frames = [_fit_rgb(width, height, image) for image in decoded]
    dibs = [_dib(width, height, frame) for frame in frames]
    fps = 12
    micro = 1_000_000 // fps
    max_frame = max(len(dib) for dib in dibs)
    avih = struct.pack(
        "<IIIIIIIIIIIIII",
        micro,
        max_frame * fps,
        0,
        0x10,
        len(dibs),
        0,
        1,
        max_frame,
        width,
        height,
        0,
        0,
        0,
        0,
    )
    strh = struct.pack(
        "<4s4sIHHIIIIIIIIhhhh",
        b"vids",
        b"DIB ",
        0,
        0,
        0,
        0,
        1,
        fps,
        0,
        len(dibs),
        max_frame,
        0xFFFFFFFF,
        0,
        0,
        0,
        width,
        height,
    )
    strf = struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, width * height * 3, 0, 0, 0, 0)
    stream_list = _list(b"strl", _chunk(b"strh", strh) + _chunk(b"strf", strf))
    hdrl = _list(b"hdrl", _chunk(b"avih", avih) + stream_list)
    movi_payload = b"movi" + b"".join(_chunk(b"00db", dib) for dib in dibs)
    movi = _chunk(b"LIST", movi_payload)
    movi_data = movi.find(b"movi") + 4
    index = bytearray()
    cursor = movi_data
    for dib in dibs:
        chunk = _chunk(b"00db", dib)
        index += struct.pack("<4sIII", b"00db", 0x10, cursor, len(dib))
        cursor += len(chunk)
    body = b"AVI " + hdrl + movi + _chunk(b"idx1", bytes(index))
    return _chunk(b"RIFF", body)


def _fit_rgb(width: int, height: int, image: tuple[int, int, bytes]) -> bytes:
    src_w, src_h, rgb = image
    if src_w == width and src_h == height:
        return rgb
    fitted = bytearray(width * height * 3)
    for y in range(height):
        sy = min(src_h - 1, y * src_h // height)
        for x in range(width):
            sx = min(src_w - 1, x * src_w // width)
            src = (sy * src_w + sx) * 3
            dst = (y * width + x) * 3
            fitted[dst : dst + 3] = rgb[src : src + 3]
    return bytes(fitted)


def _dib(width: int, height: int, rgb: bytes) -> bytes:
    stride = width * 3
    pad = (4 - (stride % 4)) % 4
    rows = []
    for y in range(height - 1, -1, -1):
        row = bytearray()
        start = y * stride
        for x in range(width):
            index = start + x * 3
            red, green, blue = rgb[index : index + 3]
            row += bytes((blue, green, red))
        row += b"\x00" * pad
        rows.append(bytes(row))
    return b"".join(rows)


def _png_chunk(tag: bytes, payload: bytes) -> bytes:
    crc = zlib.crc32(tag + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", crc)


def _chunk(tag: bytes, payload: bytes) -> bytes:
    pad = b"\x00" if len(payload) % 2 else b""
    return tag + struct.pack("<I", len(payload)) + payload + pad


def _list(kind: bytes, payload: bytes) -> bytes:
    return _chunk(b"LIST", kind + payload)


def _unfilter(filter_type: int, row: bytearray, previous: bytearray) -> None:
    if filter_type == 0:
        return
    for index, value in enumerate(row):
        left = row[index - 3] if index >= 3 else 0
        up = previous[index]
        if filter_type == 1:
            row[index] = (value + left) & 0xFF
        elif filter_type == 2:
            row[index] = (value + up) & 0xFF
        elif filter_type == 3:
            row[index] = (value + ((left + up) // 2)) & 0xFF
        elif filter_type == 4:
            up_left = previous[index - 3] if index >= 3 else 0
            row[index] = (value + _paeth(left, up, up_left)) & 0xFF
        else:
            raise ValueError("unsupported png filter")


def _paeth(left: int, up: int, up_left: int) -> int:
    estimate = left + up - up_left
    distances = (abs(estimate - left), abs(estimate - up), abs(estimate - up_left))
    if distances[0] <= distances[1] and distances[0] <= distances[2]:
        return left
    if distances[1] <= distances[2]:
        return up
    return up_left
