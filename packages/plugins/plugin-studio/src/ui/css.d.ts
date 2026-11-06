// esbuild loads .css as text for the page bundle (esbuild.config.mjs); the page puts it in a <style> tag.
declare module "*.css" {
  const css: string;
  export default css;
}
