export interface ProblemExclusion {
	source?: string;
	message?: string;
	code?: string;
}

export interface ExcludableProblem {
	source?: string;
	message: string;
	code?: string;
}

type CompiledProblemExclusion = Partial<Record<keyof ProblemExclusion, RegExp>>;

export function compileProblemExclusions(
	exclusions: readonly ProblemExclusion[],
): (problem: ExcludableProblem) => boolean {
	const compiled = exclusions.flatMap(compileProblemExclusion);
	return problem => compiled.some(exclusion =>
		matches(exclusion.source, problem.source) &&
		matches(exclusion.message, problem.message) &&
		matches(exclusion.code, problem.code),
	);
}

function compileProblemExclusion(
	exclusion: ProblemExclusion,
): CompiledProblemExclusion[] {
	const entries = (['source', 'message', 'code'] as const)
		.map(field => [field, exclusion[field]] as const)
		.filter((entry): entry is [keyof ProblemExclusion, string] =>
			typeof entry[1] === 'string' && entry[1] !== '',
		);
	if (entries.length === 0) {
		return [];
	}
	try {
		return [Object.fromEntries(entries.map(([field, pattern]) =>
			[field, new RegExp(pattern, 'u')],
		))];
	} catch {
		return [];
	}
}

function matches(pattern: RegExp | undefined, value: string | undefined): boolean {
	return pattern === undefined || (value !== undefined && pattern.test(value));
}
