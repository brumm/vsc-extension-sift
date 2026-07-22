import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectionDocument } from '../projection-document';
import {
	ProjectionBuild,
	ProjectionBuilder,
	ProjectionSessionDescriptor,
	ProjectionSessions,
	SessionPersistence,
} from '../projection-sessions';

class StubBuilder implements ProjectionBuilder {
	constructor(private readonly result: ProjectionBuild) {}

	async build(): Promise<ProjectionBuild> {
		return this.result;
	}
}

class DeferredBuilder implements ProjectionBuilder {
	private resolveBuild?: (build: ProjectionBuild) => void;

	build(): Promise<ProjectionBuild> {
		return new Promise(resolve => {
			this.resolveBuild = resolve;
		});
	}

	resolve(build: ProjectionBuild): void {
		this.resolveBuild?.(build);
	}
}

class MemoryPersistence implements SessionPersistence {
	stored: ProjectionSessionDescriptor[] = [];
	saveCount = 0;

	load(): readonly ProjectionSessionDescriptor[] {
		return this.stored;
	}

	async save(sessions: readonly ProjectionSessionDescriptor[]): Promise<void> {
		this.saveCount += 1;
		this.stored = [...sessions];
	}
}

const descriptor: ProjectionSessionDescriptor = {
	id: 'session-1',
	target: { kind: 'file', sourceUri: 'file:///workspace/example.ts' },
	filter: {
		text: 'needle',
		matchCase: false,
		wholeWord: false,
		useRegex: false,
		contextLines: 0,
	},
	languageId: 'typescript',
};

test('dirty session queues refresh until save completes', async () => {
	const projection = ProjectionDocument.message('refreshed');
	const sessions = new ProjectionSessions(
		new MemoryPersistence(),
		new StubBuilder({ projection }),
	);
	const session = sessions.open(descriptor);

	assert.deepEqual(
		await sessions.execute(session.id, { kind: 'refresh', dirty: true }),
		{ kind: 'blocked-dirty' },
	);
	assert.deepEqual(
		await sessions.execute(session.id, {
			kind: 'save-completed',
			workingCopy: session.projection.content,
		}),
		{ kind: 'saved', refreshRequired: true },
	);
	assert.equal(
		(await sessions.execute(session.id, { kind: 'refresh', dirty: false })).kind,
		'refreshed',
	);
	assert.equal(session.projection, projection);
});

test('save completion does not persist an unchanged session descriptor', async () => {
	const persistence = new MemoryPersistence();
	const sessions = new ProjectionSessions(
		persistence,
		new StubBuilder({ projection: ProjectionDocument.message('unused') }),
	);
	const session = sessions.open(descriptor);

	assert.deepEqual(await sessions.execute(session.id, {
		kind: 'save-completed',
		workingCopy: session.projection.content,
	}), { kind: 'saved', refreshRequired: false });
	assert.equal(persistence.saveCount, 0);
});

test('execute refresh builds and commits a projection behind the session seam', async () => {
	const projection = ProjectionDocument.message('built');
	const sessions = new ProjectionSessions(
		new MemoryPersistence(),
		new StubBuilder({ projection, languageId: 'typescript' }),
	);
	const session = sessions.open(descriptor);

	const outcome = await sessions.execute(session.id, {
		kind: 'refresh',
		dirty: false,
	});

	assert.equal(outcome.kind, 'refreshed');
	assert.equal(session.projection, projection);
});

test('working-copy change makes an in-flight refresh stale', async () => {
	const builder = new DeferredBuilder();
	const sessions = new ProjectionSessions(new MemoryPersistence(), builder);
	const session = sessions.open(descriptor);
	const refresh = sessions.execute(session.id, {
		kind: 'refresh',
		dirty: false,
	});

	await sessions.execute(session.id, { kind: 'working-copy-changed' });
	const staleProjection = ProjectionDocument.message('stale');
	builder.resolve({ projection: staleProjection });

	assert.deepEqual(await refresh, { kind: 'stale' });
	assert.notEqual(session.projection, staleProjection);
});

test('filter update makes an in-flight refresh stale', async () => {
	const builder = new DeferredBuilder();
	const sessions = new ProjectionSessions(new MemoryPersistence(), builder);
	const session = sessions.open(descriptor);
	const refresh = sessions.execute(session.id, {
		kind: 'refresh',
		dirty: false,
	});

	await sessions.execute(session.id, {
		kind: 'update-filter',
		filter: { ...descriptor.filter, text: 'new query' },
	});
	builder.resolve({
		projection: ProjectionDocument.message('old query'),
		languageId: 'plaintext',
	});

	assert.deepEqual(await refresh, { kind: 'stale' });
	assert.equal(session.filter.text, 'new query');
	assert.equal(session.languageId, 'typescript');
});

test('restoring sessions rejects an unknown target kind', () => {
	const persistence = new MemoryPersistence();
	persistence.stored = [{
		...descriptor,
		target: { kind: 'mystery' },
	} as unknown as ProjectionSessionDescriptor];

	const sessions = new ProjectionSessions(
		persistence,
		new StubBuilder({ projection: ProjectionDocument.message('unused') }),
	);

	assert.equal(sessions.get(descriptor.id), undefined);
});

test('restoring sessions clamps persisted context lines', () => {
	const persistence = new MemoryPersistence();
	persistence.stored = [{
		...descriptor,
		filter: { ...descriptor.filter, contextLines: 99 },
	}];

	const sessions = new ProjectionSessions(
		persistence,
		new StubBuilder({ projection: ProjectionDocument.message('unused') }),
	);

	assert.equal(sessions.get(descriptor.id)?.filter.contextLines, 5);
});

test('restores path-search sessions', () => {
	const persistence = new MemoryPersistence();
	persistence.stored = [{
		...descriptor,
		target: { kind: 'paths', rootUri: 'file:///workspace' },
		languageId: 'plaintext',
	}];

	const sessions = new ProjectionSessions(
		persistence,
		new StubBuilder({ projection: ProjectionDocument.message('unused') }),
	);

	assert.deepEqual(sessions.get(descriptor.id)?.target, {
		kind: 'paths',
		rootUri: 'file:///workspace',
	});
});

test('closing a session removes it from persistence', async () => {
	const persistence = new MemoryPersistence();
	const builder = new DeferredBuilder();
	const sessions = new ProjectionSessions(persistence, builder);
	const session = sessions.open(descriptor);
	const refresh = sessions.execute(session.id, { kind: 'refresh', dirty: false });
	await sessions.persist();
	assert.equal(persistence.stored.length, 1);

	await sessions.close(descriptor.id);
	builder.resolve({ projection: ProjectionDocument.message('late') });
	assert.deepEqual(persistence.stored, []);
	assert.deepEqual(await refresh, { kind: 'stale' });
});
