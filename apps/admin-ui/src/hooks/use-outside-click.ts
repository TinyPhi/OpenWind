import { useEffect, useRef, type RefObject } from "react";

export function useOutsideClick(
  ref: RefObject<HTMLElement | null>,
  onOutside: () => void,
): void {
  const onOutsideRef = useRef(onOutside);
  useEffect(() => {
    onOutsideRef.current = onOutside;
  });

  useEffect(() => {
    function onClickOutside(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOutsideRef.current();
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [ref]);
}
