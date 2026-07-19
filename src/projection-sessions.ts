import {
	FilterQuery,
	normalizeContextLines,
	ProjectionDocument,
} from './projection-document';

export type ProjectionTarget =
	| { kind: 'file'; sourceUri: string }
	| { kind: 'project'; rootUri: string };

export interface ProjectionSessionDescriptor {
	id: string;
	target: ProjectionTarget;
	filter: FilterQuery;
	languageId: string;
}

export interface SessionPersistence {
	load(): readonly unknown[];
	save(sessions: readonly ProjectionSessionDescriptor[]): Promise<void>;
}

interface LegacyStoredSession {
	id: string;
	kind?: 'file' | 'project';
	sourceUri?: string;
	rootUri?: string;
	query?: string;
	languageId: string;
	matchCase?: boolean;
	wholeWord?: boolean;
	useRegex?: boolean;
	contextLines?: number;
}

export interface ProjectionBuild {
	projection: ProjectionDocument;
	languageId?: string;
	message?: string;
}

export interface ProjectionBuilder {
	build(target: ProjectionTarget, filter: FilterQuery): Promise<ProjectionBuild>;
}

export type ProjectionAction =
	| { kind: 'refresh'; dirty: boolean }
	| { kind: 'working-copy-changed' }
	| { kind: 'update-filter'; filter: FilterQuery }
	| { kind: 'save-completed'; workingCopy: string }
	| { kind: 'rename-source'; sourceUri: string };

export type ProjectionActionOutcome =
	| { kind: 'refreshed'; revision: number; snapshot: ProjectionSessionSnapshot }
	| { kind: 'refresh-failed'; revision: number; snapshot: ProjectionSessionSnapshot }
	| { kind: 'blocked-dirty' }
	| { kind: 'stale' }
	| { kind: 'saved'; refreshRequired: boolean }
	| { kind: 'updated' }
	| { kind: 'missing-session' };

export type ProjectionSessionState =
	| 'ready'
	| 'refreshing'
	| 'missing';

export interface ProjectionSessionSnapshot extends ProjectionSessionDescriptor {
	projection: ProjectionDocument;
	state: ProjectionSessionState;
	message?: string;
}

export type BeginRefreshResult =
	| { kind: 'blocked-dirty' }
	| { kind: 'started'; revision: number };

export class ProjectionSession {
	private descriptorValue: ProjectionSessionDescriptor;
	private projectionValue = ProjectionDocument.message('Restoring sifted view…');
	private stateValue: ProjectionSessionState = 'refreshing';
	private messageValue?: string;
	private revision = 0;
	private refreshAfterSave = false;

	constructor(descriptor: ProjectionSessionDescriptor) {
		this.descriptorValue = descriptor;
	}

	get id(): string {
		return this.descriptorValue.id;
	}

	get target(): ProjectionTarget {
		return this.descriptorValue.target;
	}

	get filter(): FilterQuery {
		return this.descriptorValue.filter;
	}

	get languageId(): string {
		return this.descriptorValue.languageId;
	}

	get projection(): ProjectionDocument {
		return this.projectionValue;
	}

	get state(): ProjectionSessionState {
		return this.stateValue;
	}

	get message(): string | undefined {
		return this.messageValue;
	}

	isCurrent(revision: number): boolean {
		return revision === this.revision;
	}

	get snapshot(): ProjectionSessionSnapshot {
		return {
			...this.descriptorValue,
			projection: this.projectionValue,
			state: this.stateValue,
			message: this.messageValue,
		};
	}

	get descriptor(): ProjectionSessionDescriptor {
		return {
			...this.descriptorValue,
			target: { ...this.descriptorValue.target },
			filter: { ...this.descriptorValue.filter },
		};
	}

	updateFilter(filter: FilterQuery): void {
		this.descriptorValue = { ...this.descriptorValue, filter };
		this.invalidateRefresh();
	}

	setLanguageId(languageId: string): void {
		this.descriptorValue = { ...this.descriptorValue, languageId };
	}

	renameSource(sourceUri: string): void {
		if (this.target.kind === 'file') {
			this.descriptorValue = {
				...this.descriptorValue,
				target: { kind: 'file', sourceUri },
			};
			this.invalidateRefresh();
		}
	}

	beginRefresh(isDirty: boolean): BeginRefreshResult {
		if (isDirty) {
			this.revision += 1;
			this.refreshAfterSave = true;
			return { kind: 'blocked-dirty' };
		}
		this.stateValue = 'refreshing';
		return { kind: 'started', revision: ++this.revision };
	}

	workingCopyChanged(): void {
		this.invalidateRefresh(true);
	}

	completeRefresh(
		revision: number,
		projection: ProjectionDocument,
		message?: string,
	): boolean {
		if (revision !== this.revision) {
			return false;
		}
		this.projectionValue = projection;
		this.stateValue = 'ready';
		this.messageValue = message;
		return true;
	}

	failRefresh(
		revision: number,
		projection: ProjectionDocument,
		message: string,
	): boolean {
		if (revision !== this.revision) {
			return false;
		}
		this.projectionValue = projection;
		this.stateValue = 'missing';
		this.messageValue = message;
		return true;
	}

	finishSave(): boolean {
		const refresh = this.refreshAfterSave;
		this.refreshAfterSave = false;
		this.stateValue = 'ready';
		this.messageValue = undefined;
		return refresh;
	}

	acceptWorkingCopy(workingCopy: string): void {
		this.projectionValue = this.projectionValue.acceptWorkingCopy(workingCopy);
	}

	dispose(): void {
		this.revision += 1;
	}

	private invalidateRefresh(refreshAfterSave = false): void {
		if (this.stateValue !== 'refreshing') {
			return;
		}
		this.revision += 1;
		this.refreshAfterSave ||= refreshAfterSave;
		this.stateValue = 'ready';
	}
}

export class ProjectionSessions {
	private readonly sessions = new Map<string, ProjectionSession>();

	constructor(
		private readonly persistence: SessionPersistence,
		private readonly builder: ProjectionBuilder,
	) {
		for (const descriptor of normalizeStoredSessions(persistence.load())) {
			this.sessions.set(descriptor.id, new ProjectionSession(descriptor));
		}
	}

	open(descriptor: ProjectionSessionDescriptor): ProjectionSession {
		const session = new ProjectionSession(descriptor);
		this.sessions.set(descriptor.id, session);
		return session;
	}

	get(id: string): ProjectionSession | undefined {
		return this.sessions.get(id);
	}

	values(): IterableIterator<ProjectionSession> {
		return this.sessions.values();
	}

	async execute(
		id: string,
		action: ProjectionAction,
	): Promise<ProjectionActionOutcome> {
		const session = this.sessions.get(id);
		if (!session) {
			return { kind: 'missing-session' };
		}

		switch (action.kind) {
			case 'working-copy-changed':
				session.workingCopyChanged();
				return { kind: 'updated' };
			case 'update-filter':
				session.updateFilter(action.filter);
				return { kind: 'updated' };
			case 'rename-source':
				session.renameSource(action.sourceUri);
				await this.persist();
				return { kind: 'updated' };
			case 'save-completed': {
				session.acceptWorkingCopy(action.workingCopy);
				const refreshRequired = session.finishSave();
				await this.persist();
				return { kind: 'saved', refreshRequired };
			}
			case 'refresh':
				return this.refresh(session, action.dirty);
		}
	}

	private async refresh(
		session: ProjectionSession,
		dirty: boolean,
	): Promise<ProjectionActionOutcome> {
		const start = session.beginRefresh(dirty);
		if (start.kind === 'blocked-dirty') {
			return start;
		}
		try {
			const build = await this.builder.build(session.target, session.filter);
			if (
				!session.completeRefresh(
					start.revision,
					build.projection,
					build.message,
				)
			) {
				return { kind: 'stale' };
			}
			if (build.languageId) {
				session.setLanguageId(build.languageId);
			}
			await this.persist();
			return {
				kind: 'refreshed',
				revision: start.revision,
				snapshot: session.snapshot,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const targetUri = session.target.kind === 'project'
				? session.target.rootUri
				: session.target.sourceUri;
			const content = session.target.kind === 'project'
				? `Project search failed:\n${targetUri}\n\n${message}`
				: `Source is unavailable:\n${targetUri}\n\n${message}`;
			if (
				!session.failRefresh(
					start.revision,
					ProjectionDocument.message(content),
					message,
				)
			) {
				return { kind: 'stale' };
			}
			return {
				kind: 'refresh-failed',
				revision: start.revision,
				snapshot: session.snapshot,
			};
		}
	}

	async persist(): Promise<void> {
		await this.persistence.save(
			[...this.sessions.values()].map(session => session.descriptor),
		);
	}

	async close(id: string): Promise<void> {
		const session = this.sessions.get(id);
		if (session) {
			session.dispose();
			this.sessions.delete(id);
			await this.persist();
		}
	}
}

function normalizeStoredSessions(
	values: readonly unknown[],
): ProjectionSessionDescriptor[] {
	return values.flatMap(value => {
		if (!value || typeof value !== 'object') {
			return [];
		}
		const candidate = value as Partial<ProjectionSessionDescriptor> &
			Partial<LegacyStoredSession>;
		if (
			typeof candidate.id !== 'string' ||
			typeof candidate.languageId !== 'string'
		) {
			return [];
		}

		if (candidate.target && candidate.filter) {
			const target = candidate.target.kind === 'file' &&
				typeof candidate.target.sourceUri === 'string'
				? { kind: 'file' as const, sourceUri: candidate.target.sourceUri }
				: candidate.target.kind === 'project' &&
					typeof candidate.target.rootUri === 'string'
					? { kind: 'project' as const, rootUri: candidate.target.rootUri }
					: undefined;
			if (!target) {
				return [];
			}
			return [{
				id: candidate.id,
				target,
				filter: normalizeFilter(candidate.filter),
				languageId: candidate.languageId,
			}];
		}

		const target = candidate.kind === 'project'
			? typeof candidate.rootUri === 'string'
				? { kind: 'project' as const, rootUri: candidate.rootUri }
				: undefined
			: candidate.kind === undefined || candidate.kind === 'file'
				? typeof candidate.sourceUri === 'string'
					? { kind: 'file' as const, sourceUri: candidate.sourceUri }
					: undefined
				: undefined;
		if (!target) {
			return [];
		}
		return [{
			id: candidate.id,
			target,
			filter: {
				text: typeof candidate.query === 'string' ? candidate.query : '',
				matchCase: candidate.matchCase === true,
				wholeWord: candidate.wholeWord === true,
				useRegex: candidate.useRegex === true,
				contextLines: normalizeContextLines(candidate.contextLines),
			},
			languageId: candidate.languageId,
		}];
	});
}

function normalizeFilter(filter: Partial<FilterQuery>): FilterQuery {
	return {
		text: typeof filter.text === 'string' ? filter.text : '',
		matchCase: filter.matchCase === true,
		wholeWord: filter.wholeWord === true,
		useRegex: filter.useRegex === true,
		contextLines: normalizeContextLines(filter.contextLines),
	};
}
