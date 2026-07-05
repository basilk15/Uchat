export interface RendererUrlResolutionInput {
  isPackaged: boolean;
  rendererUrl?: string;
}

export const resolveRendererUrlToLoad = (input: RendererUrlResolutionInput): string | null => {
  if (input.isPackaged) {
    return null;
  }

  const rendererUrl = input.rendererUrl?.trim();
  return rendererUrl ? rendererUrl : null;
};
