import { describe, expect, it } from 'vitest';
import { resolveRendererUrlToLoad } from './rendererUrl';

describe('resolveRendererUrlToLoad', () => {
  it('returns the dev renderer url only when the app is not packaged', () => {
    expect(
      resolveRendererUrlToLoad({
        isPackaged: false,
        rendererUrl: 'http://127.0.0.1:5173'
      })
    ).toBe('http://127.0.0.1:5173');
  });

  it('ignores inherited renderer urls in packaged builds', () => {
    expect(
      resolveRendererUrlToLoad({
        isPackaged: true,
        rendererUrl: 'http://codex.local'
      })
    ).toBeNull();
  });

  it('treats blank renderer urls as absent', () => {
    expect(
      resolveRendererUrlToLoad({
        isPackaged: false,
        rendererUrl: '   '
      })
    ).toBeNull();
  });
});
