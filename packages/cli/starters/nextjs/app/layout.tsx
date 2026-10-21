import '../src/style.css';
import type { ReactNode } from 'react';
export const metadata = { title: 'Mayura notebook', description: 'A persistent notebook with explicit approvals.' };
export default function Layout({ children }: { children: ReactNode }) { return <html lang="en"><body>{children}</body></html>; }
