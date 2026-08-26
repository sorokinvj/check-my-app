import * as React from "react";
import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "w-full rounded-lg border border-ink-600 bg-ink-900 px-3.5 py-2.5 text-sm leading-6 text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-accent focus:shadow-glow",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
