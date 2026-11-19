export interface ArtifactPreviewTarget {
  id: number;
  filename: string;
  filepath?: string;
  source?: 'artifact' | 'assignment' | 'resource' | 'activity';
}

export function artifactPreviewUrl(artifact: ArtifactPreviewTarget) {
  const source = artifact.source || 'artifact';
  const query = new URLSearchParams({ filename: artifact.filename });
  if (artifact.filepath) query.set('filepath', artifact.filepath);
  return `/file-preview/${source}/${artifact.id}?${query.toString()}`;
}

export function openArtifactPreview(artifact: ArtifactPreviewTarget) {
  window.open(artifactPreviewUrl(artifact), '_blank', 'noopener,noreferrer');
}
