import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "w-full rounded-lg border border-ink-600 bg-ink-900 px-3.5 py-2.5 text-sm text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-accent focus:shadow-glow aria-[invalid=true]:border-status-broken",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
