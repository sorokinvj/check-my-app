import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "ghost" | "outline";

const variants: Record<Variant, string> = {
  primary: "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-300",
  ghost: "bg-transparent text-neutral-700 hover:bg-neutral-100",
  outline: "border border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-50",
};

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }
>(({ className, variant = "primary", ...props }, ref) => (
  <button
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed",
      variants[variant],
      className,
    )}
    {...props}
  />
));
Button.displayName = "Button";
