import path from 'path';

const MAX_REMOTE_BYTES = 50 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['github.com', 'raw.githubusercontent.com']);

function assertAllowedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('올바른 GitHub URL을 입력하세요.');
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || !ALLOWED_HOSTS.has(hostname)) {
    throw new Error('github.com 또는 raw.githubusercontent.com의 HTTPS 파일 링크만 사용할 수 있습니다.');
  }
  return url;
}

export function githubFetchUrl(value: string): string {
  const url = assertAllowedUrl(value);
  if (url.hostname.toLowerCase() !== 'github.com') return url.toString();
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/);
  if (!match) throw new Error('GitHub 파일 링크는 blob 또는 raw 형식이어야 합니다.');
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
}

export function remoteFilename(value: string, fallback = 'GitHub 자료'): string {
  const url = assertAllowedUrl(value);
  const name = decodeURIComponent(path.posix.basename(url.pathname));
  return name && name !== '/' ? name : fallback;
}

export async function fetchGithubSource(value: string): Promise<{ buffer: Buffer; contentType: string; fetchUrl: string }> {
  let current = githubFetchUrl(value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await fetch(current, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'AI-Assessment-Assistant' },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`GitHub 응답에 이동할 주소가 없습니다. (${response.status})`);
        current = assertAllowedUrl(new URL(location, current).toString()).toString();
        continue;
      }
      if (!response.ok) throw new Error(`GitHub에서 자료를 가져오지 못했습니다. (HTTP ${response.status})`);
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > MAX_REMOTE_BYTES) throw new Error('GitHub 자료는 50MB 이하여야 합니다.');
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_REMOTE_BYTES) throw new Error('GitHub 자료는 50MB 이하여야 합니다.');
      return {
        buffer,
        contentType: response.headers.get('content-type') || 'application/octet-stream',
        fetchUrl: current,
      };
    }
    throw new Error('GitHub 링크가 너무 많이 이동되었습니다.');
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error('GitHub 연결 시간이 초과되었습니다.');
    if ((error as Error).message === 'fetch failed') throw new Error('GitHub에 연결할 수 없습니다. 교사 PC의 인터넷 연결을 확인하세요.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchGithubText(value: string): Promise<string> {
  const result = await fetchGithubSource(value);
  return result.buffer.toString('utf8');
}
