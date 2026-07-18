import type { SVGProps } from "react";

export function PiMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" {...props}>
      <path
        d="M7 10.5h18M11 10.5V23m10-12.5V23"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
      />
      <path
        d="M5.5 15.5h21"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        opacity=".42"
      />
    </svg>
  );
}
