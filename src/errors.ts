/** Thrown when the environment cannot run the sandbox (for example, Deno cannot be obtained). */
export class SandboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxError";
  }
}

/** Thrown when the options passed to exec() are invalid. The developer, not the LLM, has to fix these. */
export class SandboxConfigError extends SandboxError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxConfigError";
  }
}

// A reason to stop before running the code that the LLM can fix (a package that is not
// allowed, an import of a file outside the allowed directories, ...). exec() turns it into
// a result with exitCode 1. Not exported from the package.
export class RejectedError extends Error {}
