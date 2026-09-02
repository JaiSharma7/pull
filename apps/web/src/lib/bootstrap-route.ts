export type BootstrapTarget = 'app' | 'design-preview';

export function bootstrapTarget(pathname: string): BootstrapTarget {
  const clean = pathname.replace(/\/+$/, '') || '/';
  return clean === '/design-preview' ? 'design-preview' : 'app';
}
