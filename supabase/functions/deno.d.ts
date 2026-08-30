/**
 * The slice of the Deno runtime these functions actually use.
 *
 * Declared rather than pulled from `@types/deno` so the surface stays honest:
 * if a function starts using something new, it fails to compile here and gets
 * added deliberately. A wholesale ambient type would make every Deno API look
 * available in an environment that only really guarantees these.
 *
 * The functions are never executed by Node. This exists so `tsc` can check
 * them, which nothing did before they joined the workspace.
 */
declare namespace Deno {
  export const env: {
    get(key: string): string | undefined;
  };

  export function serve(handler: (request: Request) => Response | Promise<Response>): {
    finished: Promise<void>;
  };
}
