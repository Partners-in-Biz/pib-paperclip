/**
 * The SVG filter for a clip's pixel effects (PAR-10177), in the render's order: rgbSplit, blurIn, flash. `region` is
 * the picture the effects act on (the whole frame for a main clip, the contained picture for an overlay). sRGB maths
 * as ffmpeg's. `opaque`: the picture has no alpha (a video), so blur edges are normalised by resetting alpha to 1, as
 * `GradeFilter` does; a sticker keeps its alpha (blur included, as the render's yuva).
 * rgbSplit: red and blue are shifted by whole px with edge duplication (the render's `rgbashift edge=smear`), each
 * channel is lifted into its own image and the three are summed. A sticker's own alpha is put back at the end (the
 * render never moves it).
 */
import type { ReactElement } from "react";
import type { Box } from "./preview-plan.js";
import { flashMatrix, type EffectPixels } from "./effect-filter.js";

const n4 = (n: number) => String(Math.round(n * 10000) / 10000 || 0);
const CHANNEL = {
  r: "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1",
  g: "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 0 1",
  b: "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 0 1",
} as const;

export function EffectFilter({ id, region: r, fx, opaque }: { id: string; region: Box; fx: EffectPixels; opaque: boolean }) {
  let last = "SourceGraphic";
  const steps: ReactElement[] = [];
  if (fx.split > 0) {
    // feConvolveMatrix with edgeMode duplicate shifts a plane by whole px and repeats the edge column: the render's
    // `rgbashift edge=smear`. Red moves left (output(x) = input(x + d)), blue right (input(x - d)); alpha is kept.
    const d = Math.max(1, Math.round(fx.split));
    const kernel = (at: number) => Array.from({ length: 2 * d + 1 }, (_, i) => (i === at ? 1 : 0)).join(" ");
    const shift = (c: "r" | "b", at: number) => [
      <feConvolveMatrix key={`${c}c`} in="SourceGraphic" order={`${2 * d + 1} 1`} kernelMatrix={kernel(at)} targetX={d} targetY={0} edgeMode="duplicate" preserveAlpha="true" result={`${c}s`} />,
      <feColorMatrix key={`${c}m`} in={`${c}s`} type="matrix" values={CHANNEL[c]} result={`${c}2`} />,
    ];
    steps.push(
      ...shift("r", 0),
      ...shift("b", 2 * d),
      <feColorMatrix key="g" in="SourceGraphic" type="matrix" values={CHANNEL.g} result="g0" />,
      <feComposite key="rg" in="r2" in2="g0" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="rg" />,
      <feComposite key="rgb" in="rg" in2="b2" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="split" />,
    );
    last = "split";
    if (!opaque) {
      steps.push(<feComposite key="alpha" in="split" in2="SourceGraphic" operator="in" result="splitA" />);
      last = "splitA";
    }
  }
  if (fx.blur > 0) {
    steps.push(<feGaussianBlur key="blur" in={last} stdDeviation={n4(fx.blur)} result={opaque ? "blurred" : "blurA"} />);
    last = opaque ? "blurred" : "blurA";
    if (!opaque) {
      // The render blurs the colour planes and the alpha plane apart (straight alpha), so an edge shows colour x alpha
      // blurred twice; an SVG blur is premultiplied, so multiply its colour by the blurred alpha once more.
      steps.push(
        <feColorMatrix key="blurAlphaGrey" in="blurA" type="matrix" values="0 0 0 1 0  0 0 0 1 0  0 0 0 1 0  0 0 0 0 1" result="blurAlphaGrey" />,
        <feComposite key="blurStraight" in="blurA" in2="blurAlphaGrey" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="blurStraight" />,
      );
      last = "blurStraight";
    }
    if (opaque) {
      steps.push(<feComponentTransfer key="blurAlpha" in="blurred" result="blurOpaque"><feFuncA type="table" tableValues="1 1" /></feComponentTransfer>);
      last = "blurOpaque";
    }
  }
  if (fx.white > 0) steps.push(<feColorMatrix key="flash" in={last} type="matrix" values={flashMatrix(fx.white).map(n4).join(" ")} />);
  return (
    <svg aria-hidden width={0} height={0} style={{ position: "absolute" }}>
      <filter id={id} filterUnits="userSpaceOnUse" x={n4(r.x)} y={n4(r.y)} width={n4(r.width)} height={n4(r.height)} colorInterpolationFilters="sRGB">
        {steps}
      </filter>
    </svg>
  );
}
