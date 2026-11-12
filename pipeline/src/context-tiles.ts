import sharp from "sharp";

export const CONTEXT_BACKGROUND = [232,228,220] as const;
export const CONTEXT_VERSION = "context-blur2-matched";
/** Render -> painting colour transfer (per channel: (v - mean_render) * sd_paint / sd_render + mean_paint),
 *  measured on 72 roma-inner tiles that have both (render 152.8/136.4/109.4 ± 49.3/38.0/46.3,
 *  paint 171.7/139.8/100.9 ± 48.0/30.1/41.2): unpainted context gets the painting's warm palette, so
 *  the painted city does not stand out as an orange patch on a grey map. */
const MATCH_SCALE = [0.974, 0.792, 0.89], MATCH_OFFSET = [22.9, 31.8, 3.5];
/** Blur BEFORE splitting web tiles, using actual neighbours as a convolution gutter. */
export async function contextTile(sources: Map<string,string>, tx: number, ty: number, size=1024) {
  const pad=48, width=size+pad*2, composites=[];
  for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
    const file=sources.get(`${tx+dx}_${ty+dy}`); if(!file) continue;
    const left=pad+dx*size, top=pad+dy*size;
    const sx=Math.max(0,-left), sy=Math.max(0,-top);
    const w=Math.min(size-sx,width-Math.max(0,left)), h=Math.min(size-sy,width-Math.max(0,top));
    if(w>0&&h>0) composites.push({input:await sharp(file).removeAlpha().extract({left:sx,top:sy,width:w,height:h}).linear(MATCH_SCALE,MATCH_OFFSET).png().toBuffer(),left:Math.max(0,left),top:Math.max(0,top)});
  }
  const [r,g,b]=CONTEXT_BACKGROUND;
  const mosaic=await sharp({create:{width,height:width,channels:3,background:{r,g,b}}}).composite(composites).png().toBuffer();
  const blurred=await sharp(mosaic).removeAlpha().blur(12)
    .modulate({saturation:0.92}).linear([0.9,0.9,0.9],[r*0.1,g*0.1,b*0.1]).png().toBuffer();
  return sharp(blurred).extract({left:pad,top:pad,width:size,height:size}).png().toBuffer();
}
