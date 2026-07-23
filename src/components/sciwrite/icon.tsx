"use client";

import * as React from "react";
import * as Icons from "lucide-react";

export function Icon({
  name,
  className,
  ...props
}: { name: string; className?: string } & React.SVGProps<SVGSVGElement>) {
  const Cmp = (Icons as unknown as Record<string, React.ComponentType<any>>)[
    name
  ];
  if (!Cmp) return null;
  return <Cmp className={className} {...props} />;
}
