// The npm package ships built JS only — no .d.ts. Minimal ambient declaration
// covering the surface this spike uses, derived from reading the built module
// and the official LAM_WebRender example (src/gaussianAvatar.ts).
declare module "gaussian-splat-renderer-for-lam" {
  /** Per-frame ARKit blendshapes: { [arkitName]: weight 0..1 }. */
  export type ArkitFrame = Record<string, number>;

  export interface RendererOptions {
    /** Polled every frame. Return current ARKit blendshape weights. */
    getExpressionData?: () => ArkitFrame;
    /** Polled every frame. "Idle" | "Listening" | "Thinking" | "Responding". */
    getChatState?: () => string;
    backgroundColor?: string;
    alpha?: number;
    enablePan?: boolean;
  }

  export class GaussianSplatRenderer {
    static getInstance(
      container: HTMLElement,
      assetPath: string,
      options?: RendererOptions,
    ): Promise<GaussianSplatRenderer>;
  }
}

declare module "*.json" {
  const value: any;
  export default value;
}
