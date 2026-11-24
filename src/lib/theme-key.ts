export const THEME_KEY = "ocb-theme";

export const THEME_SCRIPT =
  "(function(){try{" +
  `var t=localStorage.getItem('${THEME_KEY}');` +
  "var d=t==='dark'||(!t&&window.matchMedia(" +
  "'(prefers-color-scheme: dark)').matches);" +
  "if(d)document.documentElement.classList.add('dark');" +
  "}catch(e){}})();";
