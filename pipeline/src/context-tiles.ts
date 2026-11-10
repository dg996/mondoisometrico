import sharp from "sharp";

export const CONTEXT_BACKGROUND = [232,228,220] as const;
export const CONTEXT_VERSION = "context-blur1";
/** Blur BEFORE splitting web tiles, using actual neighbours as a convolution gutter. */
export async function contextTile(sources: Map<string,string>, tx: number, ty: number, size=1024) {
  const pad=48, width=size+pad*2, composites=[];
  for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
    const file=sources.get(`${tx+dx}_${ty+dy}`); if(!file) continue;
    const left=pad+dx*size, top=pad+dy*size;
    const sx=Math.max(0,-left), sy=Math.max(0,-top);
    const w=Math.min(size-sx,width-Math.max(0,left)), h=Math.min(size-sy,width-Math.max(0,top));
    if(w>0&&h>0) composites.push({input:await sharp(file).extract({left:sx,top:sy,width:w,height:h}).png().toBuffer(),left:Math.max(0,left),top:Math.max(0,top)});
  }
  const [r,g,b]=CONTEXT_BACKGROUND;
  const mosaic=await sharp({create:{width,height:width,channels:3,background:{r,g,b}}}).composite(composites).png().toBuffer();
  const blurred=await sharp(mosaic).removeAlpha().blur(12).modulate({saturation:0.65})
    .linear([0.78,0.78,0.78],[r*0.22,g*0.22,b*0.22]).png().toBuffer();
  return sharp(blurred).extract({left:pad,top:pad,width:size,height:size}).png().toBuffer();
}
