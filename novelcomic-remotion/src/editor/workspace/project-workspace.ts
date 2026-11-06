import type {DocumentState} from '../document';

export type WorkspaceTab = {
	projectId: string;
	document: DocumentState;
	savedContentHash: string;
	dirty: boolean;
	active: boolean;
	lastOpenedAt: string;
	};
export type WorkspaceStorage = {getItem: (key: string) => string | null; setItem: (key: string, value: string) => void};

const RECENTS_KEY = 'novelcomic-remotion-recent-projects-v1';
const clone = <T>(value: T): T => structuredClone(value);

export class ProjectWorkspace {
	private tabs: WorkspaceTab[] = [];
	private recents: string[] = [];
	constructor(private readonly storage?: WorkspaceStorage) { this.loadRecents(); }
	listTabs(): WorkspaceTab[] { return this.tabs.map(clone); }
	get activeTab(): WorkspaceTab | null { return clone(this.tabs.find((tab) => tab.active) ?? null); }
	get recentProjectIds(): string[] { return [...this.recents]; }
	open(document: DocumentState, savedContentHash: string): WorkspaceTab { const existing = this.tabs.find((tab) => tab.projectId === document.projectId); const timestamp = new Date().toISOString(); if (existing) { existing.document = clone(document); existing.savedContentHash = savedContentHash; existing.dirty = false; existing.active = true; existing.lastOpenedAt = timestamp; } else { this.tabs.forEach((tab) => { tab.active = false; }); this.tabs.push({projectId: document.projectId, document: clone(document), savedContentHash, dirty: false, active: true, lastOpenedAt: timestamp}); } this.touchRecent(document.projectId); return clone(this.activeTab)!; }
	update(document: DocumentState): void { const tab = this.tabs.find((entry) => entry.projectId === document.projectId); if (!tab) throw new Error(`Project ${document.projectId} is not open`); tab.document = clone(document); tab.dirty = true; }
	markSaved(projectId: string, contentHash: string): void { const tab = this.require(projectId); tab.savedContentHash = contentHash; tab.dirty = false; }
	isDirty(projectId: string): boolean { return this.require(projectId).dirty; }
	activate(projectId: string): WorkspaceTab { const tab = this.require(projectId); this.tabs.forEach((entry) => { entry.active = entry.projectId === projectId; }); this.touchRecent(projectId); return clone(tab); }
	close(projectId: string, decision: 'discard' | 'keep-open' = 'keep-open'): boolean { this.require(projectId); if (this.isDirty(projectId) && decision !== 'discard') return false; this.tabs = this.tabs.filter((entry) => entry.projectId !== projectId); if (!this.tabs.some((entry) => entry.active) && this.tabs[0]) this.tabs[0].active = true; return true; }
	applyExternalChange(projectId: string, document: DocumentState, contentHash: string, decision: 'reload' | 'keep-local'): WorkspaceTab { const tab = this.require(projectId); if (decision === 'reload') { tab.document = clone(document); tab.savedContentHash = contentHash; tab.dirty = false; } return clone(tab); }
	private require(projectId: string): WorkspaceTab { const tab = this.tabs.find((entry) => entry.projectId === projectId); if (!tab) throw new Error(`Project ${projectId} is not open`); return tab; }
	private touchRecent(projectId: string): void { this.recents = [projectId, ...this.recents.filter((id) => id !== projectId)].slice(0, 20); this.storage?.setItem(RECENTS_KEY, JSON.stringify(this.recents)); }
	private loadRecents(): void { const raw = this.storage?.getItem(RECENTS_KEY); if (!raw) return; try { const parsed = JSON.parse(raw); if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')) this.recents = parsed.slice(0, 20); } catch { this.recents = []; } }
}

export const RECENT_PROJECTS_STORAGE_KEY = RECENTS_KEY;
