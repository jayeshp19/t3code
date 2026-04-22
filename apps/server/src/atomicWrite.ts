import * as Crypto from "node:crypto";

import { Effect, FileSystem, Path } from "effect";

export const makeAtomicWriteTempPath = (filePath: string): string =>
  `${filePath}.${process.pid}.${Crypto.randomUUID()}.tmp`;

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
}) => {
  const tempPath = makeAtomicWriteTempPath(input.filePath);
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* fs.makeDirectory(path.dirname(input.filePath), { recursive: true });
    yield* fs.writeFileString(tempPath, input.contents);
    yield* fs.rename(tempPath, input.filePath);
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true }));
      }),
    ),
  );
};
