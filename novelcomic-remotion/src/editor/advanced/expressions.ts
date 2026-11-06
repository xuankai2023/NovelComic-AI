export type ExpressionValue = number | readonly number[];

export type ExpressionNode =
	| {type: 'literal'; value: number}
	| {type: 'identifier'; name: string}
	| {type: 'unary'; operator: '+' | '-'; argument: ExpressionNode}
	| {
			type: 'binary';
			operator: '+' | '-' | '*' | '/' | '%';
			left: ExpressionNode;
			right: ExpressionNode;
	  }
	| {type: 'call'; name: string; arguments: ExpressionNode[]}
	| {type: 'vector'; elements: ExpressionNode[]};

export type ExpressionContext = {
	time: number;
	frame: number;
	fps: number;
	value: ExpressionValue;
	seed: number;
};

export type ExpressionEvaluation = {
	value: ExpressionValue;
	diagnostics: string[];
	usedFallback: boolean;
};

export const EXPRESSION_VARIABLES = [
	'time',
	'frame',
	'fps',
	'value',
	'seed',
] as const;

export const EXPRESSION_FUNCTIONS = [
	'linear',
	'ease',
	'clamp',
	'lerp',
	'sin',
	'cos',
	'abs',
	'min',
	'max',
	'randomSeeded',
] as const;

type Operator = '+' | '-' | '*' | '/' | '%';
type Punctuation = '(' | ')' | '[' | ']' | ',';
type Token =
	| {type: 'number'; value: number}
	| {type: 'identifier'; value: string}
	| {type: 'operator'; value: Operator}
	| {type: 'punctuation'; value: Punctuation}
	| {type: 'eof'};

const isIdentifierStart = (value: string): boolean =>
	/[A-Za-z_]/.test(value);

const isIdentifierPart = (value: string): boolean =>
	/[A-Za-z0-9_]/.test(value);

const tokenize = (source: string): Token[] => {
	const tokens: Token[] = [];
	let index = 0;

	while (index < source.length) {
		const character = source[index]!;
		if (/\s/.test(character)) {
			index += 1;
			continue;
		}

		if (character === '.' && !/[0-9]/.test(source[index + 1] ?? '')) {
			throw new Error('Unknown expression identifier member access');
		}

		if (/[0-9.]/.test(character)) {
			const start = index;
			let dots = 0;
			while (index < source.length && /[0-9.]/.test(source[index]!)) {
				if (source[index] === '.') dots += 1;
				index += 1;
			}
			const raw = source.slice(start, index);
			if (dots > 1 || raw === '.') {
				throw new Error(`Invalid number near "${raw}"`);
			}
			const value = Number(raw);
			if (!Number.isFinite(value)) {
				throw new Error(`Invalid number near "${raw}"`);
			}
			tokens.push({type: 'number', value});
			continue;
		}

		if (isIdentifierStart(character)) {
			const start = index;
			index += 1;
			while (index < source.length && isIdentifierPart(source[index]!)) {
				index += 1;
			}
			tokens.push({
				type: 'identifier',
				value: source.slice(start, index),
			});
			continue;
		}

		if ('+-*/%'.includes(character)) {
			tokens.push({type: 'operator', value: character as Operator});
			index += 1;
			continue;
		}

		if ('()[],'.includes(character)) {
			tokens.push({
				type: 'punctuation',
				value: character as Punctuation,
			});
			index += 1;
			continue;
		}

		throw new Error(`Unsupported expression character "${character}"`);
	}

	tokens.push({type: 'eof'});
	return tokens;
};

const BINARY_PRECEDENCE: Record<Operator, number> = {
	'+': 10,
	'-': 10,
	'*': 20,
	'/': 20,
	'%': 20,
};

class Parser {
	private readonly tokens: Token[];
	private index = 0;
	private readonly dependencies = new Set<string>();

	constructor(source: string) {
		this.tokens = tokenize(source);
	}

	parse(): {ast: ExpressionNode; dependencies: string[]} {
		const ast = this.parseExpression(0);
		if (this.peek().type !== 'eof') {
			throw new Error('Unexpected tokens after expression');
		}
		return {ast, dependencies: [...this.dependencies].sort()};
	}

	private peek(): Token {
		return this.tokens[this.index]!;
	}

	private consume(): Token {
		const token = this.peek();
		this.index += 1;
		return token;
	}

	private expectPunctuation(value: Punctuation): void {
		const token = this.consume();
		if (token.type !== 'punctuation' || token.value !== value) {
			throw new Error(`Expected "${value}"`);
		}
	}

	private parseExpression(minPrecedence: number): ExpressionNode {
		let left = this.parsePrefix();

		while (true) {
			const token = this.peek();
			if (token.type !== 'operator') break;
			const operator = token.value;
			const precedence = BINARY_PRECEDENCE[operator];
			if (precedence < minPrecedence) break;
			this.consume();
			const right = this.parseExpression(precedence + 1);
			left = {type: 'binary', operator, left, right};
		}

		return left;
	}

	private parsePrefix(): ExpressionNode {
		const token = this.consume();
		if (token.type === 'number') {
			return {type: 'literal', value: token.value};
		}

		if (token.type === 'operator' && (token.value === '+' || token.value === '-')) {
			return {
				type: 'unary',
				operator: token.value,
				argument: this.parseExpression(30),
			};
		}

		if (token.type === 'punctuation' && token.value === '(') {
			const expression = this.parseExpression(0);
			this.expectPunctuation(')');
			return expression;
		}

			if (token.type === 'punctuation' && token.value === '[') {
				const elements: ExpressionNode[] = [];
				const firstToken = this.peek();
				if (!(firstToken.type === 'punctuation' && firstToken.value === ']')) {
					while (true) {
						elements.push(this.parseExpression(0));
						const separator = this.peek();
						if (separator.type === 'punctuation' && separator.value === ',') {
							this.consume();
							continue;
						}
					break;
				}
			}
			this.expectPunctuation(']');
			if (elements.length === 0) {
				throw new Error('Expression vectors cannot be empty');
			}
			return {type: 'vector', elements};
		}

		if (token.type === 'identifier') {
			const isVariable = (EXPRESSION_VARIABLES as readonly string[]).includes(
				token.value,
			);
			const isFunction = (EXPRESSION_FUNCTIONS as readonly string[]).includes(
				token.value,
			);
			if (!isVariable && !isFunction) {
				throw new Error(`Unknown expression identifier "${token.value}"`);
			}

				const callStart = this.peek();
				if (callStart.type === 'punctuation' && callStart.value === '(') {
				if (!isFunction) {
					throw new Error(`"${token.value}" is not a function`);
				}
				this.consume();
				const args: ExpressionNode[] = [];
				const firstArgument = this.peek();
				if (
					!(
						firstArgument.type === 'punctuation' &&
						firstArgument.value === ')'
					)
				) {
					while (true) {
						args.push(this.parseExpression(0));
						const separator = this.peek();
						if (separator.type === 'punctuation' && separator.value === ',') {
							this.consume();
							continue;
						}
						break;
					}
				}
				this.expectPunctuation(')');
				return {type: 'call', name: token.value, arguments: args};
			}

			if (!isVariable) {
				throw new Error(`Function "${token.value}" requires parentheses`);
			}
			this.dependencies.add(token.value);
			return {type: 'identifier', name: token.value};
		}

		throw new Error(
			'Expected a number, variable, function, or grouped expression',
		);
	}
}

const isVector = (value: ExpressionValue): value is readonly number[] =>
	Array.isArray(value);

const finite = (value: number, fallback = 0): number =>
	Number.isFinite(value) ? value : fallback;

const mapBinary = (
	left: ExpressionValue,
	right: ExpressionValue,
	operation: (left: number, right: number) => number,
): ExpressionValue => {
	if (!isVector(left) && !isVector(right)) {
		return finite(operation(left, right));
	}

	const leftValues = isVector(left) ? left : [left];
	const rightValues = isVector(right) ? right : [right];
	const length = Math.max(leftValues.length, rightValues.length);
	return Array.from({length}, (_unused, index) =>
		finite(
			operation(
				leftValues[index] ?? leftValues[leftValues.length - 1]!,
				rightValues[index] ?? rightValues[rightValues.length - 1]!,
			),
		),
	);
};

const scalar = (value: ExpressionValue, label: string): number => {
	if (typeof value === 'number') return finite(value);
	if (value.length === 1) return finite(value[0]!);
	throw new Error(`${label} must be a scalar`);
};

const deterministicRandom = (seed: number): number => {
	let state = Math.imul(Math.trunc(seed) + 0x6d2b79f5, 0x9e3779b1);
	state ^= state >>> 16;
	state = Math.imul(state, 0x7feb352d);
	state ^= state >>> 15;
	return (state >>> 0) / 4294967296;
};

const callFunction = (
	name: string,
	args: ExpressionValue[],
	context: ExpressionContext,
): ExpressionValue => {
	const value = (index: number, label: string): number => {
		const argument = args[index];
		if (argument === undefined) {
			throw new Error(`${name} requires ${label}`);
		}
		return scalar(argument, label);
	};

	switch (name) {
		case 'linear': {
			if (args.length !== 5) throw new Error('linear requires 5 arguments');
			const amount = value(0, 'amount');
			const inputMin = value(1, 'inputMin');
			const inputMax = value(2, 'inputMax');
			const outputMin = value(3, 'outputMin');
			const outputMax = value(4, 'outputMax');
			if (inputMin === inputMax) return outputMin;
			return (
				outputMin +
				(outputMax - outputMin) *
					((amount - inputMin) / (inputMax - inputMin))
			);
		}
		case 'ease': {
			if (args.length !== 5) throw new Error('ease requires 5 arguments');
			const amount = value(0, 'amount');
			const inputMin = value(1, 'inputMin');
			const inputMax = value(2, 'inputMax');
			const outputMin = value(3, 'outputMin');
			const outputMax = value(4, 'outputMax');
			if (inputMin === inputMax) return outputMin;
			const raw = (amount - inputMin) / (inputMax - inputMin);
			const progress = Math.max(0, Math.min(1, raw));
			const eased = progress * progress * (3 - 2 * progress);
			return outputMin + (outputMax - outputMin) * eased;
		}
		case 'clamp': {
			if (args.length !== 3) throw new Error('clamp requires 3 arguments');
			const amount = value(0, 'value');
			return Math.max(value(1, 'min'), Math.min(value(2, 'max'), amount));
		}
		case 'lerp': {
			if (args.length !== 3) throw new Error('lerp requires 3 arguments');
			const amount = value(2, 'amount');
			return mapBinary(
				args[0]!,
				args[1]!,
				(left, right) => left + (right - left) * amount,
			);
		}
		case 'sin':
		case 'cos':
		case 'abs': {
			if (args.length !== 1) throw new Error(`${name} requires 1 argument`);
			const operation =
				name === 'sin' ? Math.sin : name === 'cos' ? Math.cos : Math.abs;
			return isVector(args[0]!)
				? args[0]!.map((entry) => finite(operation(entry)))
				: finite(operation(args[0]!));
		}
		case 'min':
		case 'max': {
			if (args.length < 1) {
				throw new Error(`${name} requires at least 1 argument`);
			}
			const values = args.map((entry) => scalar(entry, 'value'));
			return name === 'min' ? Math.min(...values) : Math.max(...values);
		}
		case 'randomSeeded': {
			if (args.length > 1) {
				throw new Error('randomSeeded accepts zero or one argument');
			}
			return deterministicRandom(
				args.length === 1 ? scalar(args[0]!, 'seed') : context.seed,
			);
		}
		default:
			throw new Error(`Unsupported expression function "${name}"`);
	}
};

const evaluateNode = (
	node: ExpressionNode,
	context: ExpressionContext,
): ExpressionValue => {
	switch (node.type) {
		case 'literal':
			return node.value;
		case 'identifier':
			return context[node.name as keyof ExpressionContext] as ExpressionValue;
		case 'vector':
			return node.elements.map((element) =>
				scalar(evaluateNode(element, context), 'vector element'),
			);
		case 'unary': {
			const value = evaluateNode(node.argument, context);
			return node.operator === '+'
				? value
				: isVector(value)
					? value.map((entry) => -entry)
					: -value;
		}
		case 'binary':
			return mapBinary(
				evaluateNode(node.left, context),
				evaluateNode(node.right, context),
				(left, right) => {
					switch (node.operator) {
						case '+':
							return left + right;
						case '-':
							return left - right;
						case '*':
							return left * right;
						case '/':
							return right === 0 ? 0 : left / right;
						case '%':
							return right === 0 ? 0 : left % right;
					}
				},
			);
		case 'call':
			return callFunction(
				node.name,
				node.arguments.map((argument) => evaluateNode(argument, context)),
				context,
			);
	}
};

export const parseExpression = (
	source: string,
): {ast: ExpressionNode; dependencies: string[]} => {
	if (source.trim().length === 0) {
		throw new Error('Expression cannot be empty');
	}
	if (source.length > 1000) {
		throw new Error('Expression is too long');
	}
	return new Parser(source).parse();
};

export const evaluateParsedExpression = (
	ast: ExpressionNode,
	context: ExpressionContext,
): ExpressionValue => evaluateNode(ast, context);

export const evaluateExpression = (
	ast: ExpressionNode,
	context: ExpressionContext,
	fallback: ExpressionValue,
): ExpressionEvaluation => {
	try {
		const value = evaluateParsedExpression(ast, context);
		if (
			(typeof value === 'number' && !Number.isFinite(value)) ||
			(isVector(value) && value.some((entry) => !Number.isFinite(entry)))
		) {
			throw new Error('Expression returned a non-finite value');
		}
		return {value, diagnostics: [], usedFallback: false};
	} catch (error) {
		return {
			value: fallback,
			diagnostics: [
				error instanceof Error ? error.message : 'Expression evaluation failed',
			],
			usedFallback: true,
		};
	}
};

export const expressionValueAsNumber = (
	value: ExpressionValue,
	fallback: number,
): number => {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (Array.isArray(value) && value.length === 1 && Number.isFinite(value[0])) {
		return value[0];
	}
	return fallback;
};
