import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function pdftoppmCandidates(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const platformPaths = platform === 'darwin'
    ? [
        '/opt/homebrew/bin/pdftoppm',
        '/usr/local/bin/pdftoppm',
        '/usr/bin/pdftoppm',
      ]
    : platform === 'win32'
      ? []
      : [
          '/usr/bin/pdftoppm',
          '/usr/local/bin/pdftoppm',
        ];

  return unique([
    env.ASSESSMENT_PDFTOPPM,
    ...platformPaths.filter((candidate) => fs.existsSync(candidate)),
    'pdftoppm',
  ]);
}

export async function runPdftoppm(
  args: string[],
  options: { timeout: number },
): Promise<void> {
  let lastError: unknown;
  const attempted: string[] = [];

  for (const executable of pdftoppmCandidates()) {
    attempted.push(executable);
    try {
      await execFileAsync(executable, args, options);
      return;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError || '실행 파일 없음');
  throw new Error(
    `PDF 변환 프로그램(pdftoppm)을 찾을 수 없습니다. `
    + `확인한 위치: ${attempted.map((item) => path.normalize(item)).join(', ')}. ${detail}`,
  );
}
