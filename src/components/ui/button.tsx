import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[4px] border border-transparent font-mono text-[10px] font-medium outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-[var(--ring)] disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        primary: "bg-[var(--fg)] text-[var(--canvas)] hover:opacity-85",
        secondary:
          "border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] hover:bg-[var(--subtle)]",
        ghost: "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]",
        danger: "bg-[var(--error)] text-white hover:opacity-85",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 px-2.5 text-[9px]",
        icon: "size-7 p-0",
        compact: "size-6 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { buttonVariants };
