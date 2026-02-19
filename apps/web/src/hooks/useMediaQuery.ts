import { useEffect, useState } from "react";

function getMediaQueryMatch(query: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => getMediaQueryMatch(query));

  useEffect(() => {
    const mediaQueryList = window.matchMedia(query);
    const handleChange = () => {
      setMatches(mediaQueryList.matches);
    };

    setMatches(mediaQueryList.matches);

    if (mediaQueryList.addEventListener) {
      mediaQueryList.addEventListener("change", handleChange);
      return () => {
        mediaQueryList.removeEventListener("change", handleChange);
      };
    }
    mediaQueryList.addListener(handleChange);
    return () => {
      mediaQueryList.removeListener(handleChange);
    };
  }, [query]);

  return matches;
}
