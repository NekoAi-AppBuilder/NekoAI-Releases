import { useEffect, useState } from "react";

/** Presentation-only subscription shared by syntax viewers and Markdown. */
export function useInterfaceTheme(): "dark" | "light" {
  const read = () => document.body.classList.contains("theme-bright") ? "light" as const : "dark" as const;
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const update = () => setTheme(read());
    const observer = new MutationObserver(update);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    update();
    return () => observer.disconnect();
  }, []);
  return theme;
}
