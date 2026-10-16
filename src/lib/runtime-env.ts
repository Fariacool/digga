import 'server-only';

// Reflect.get keeps Next.js from inlining NEXT_PUBLIC_* property reads.
export function getRuntimeEnv(name: string): string | undefined {
	return Reflect.get(process.env, name);
}
