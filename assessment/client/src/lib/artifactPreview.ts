export interface ArtifactPreviewTarget {
  id: number;
  filename: string;
  source?: 'artifact' | 'assignment' | 'resource' | 'activity';
}

export function artifactPreviewUrl(artifact: ArtifactPreviewTarget) {
  const source = artifact.source || 'artifact';
  const query = new URLSearchParams({ filename: artifact.filename });
  return `/file-preview/${source}/${artifact.id}?${query.toString()}`;
}

export function openArtifactPreview(artifact: ArtifactPreviewTarget) {
  window.open(artifactPreviewUrl(artifact), '_blank', 'noopener,noreferrer');
}
