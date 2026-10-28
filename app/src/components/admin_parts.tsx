import { Badge } from '@/components/ui/badge';

/** Links in the admin screens' text and tables. */
export const ADMIN_LINK_CLASS = 'font-medium text-foreground underline underline-offset-4';

/** The admin tables' captions sit on top, where the old tables had them. */
export const ADMIN_CAPTION_CLASS = 'mt-0 mb-2 caption-top text-left font-medium text-foreground';

/** Figures in the admin tables are right-aligned; the tables use tabular digits. */
export const NUMBER_CLASS = 'text-right';

/** The grid of stat tiles: as many 150 px columns as fit, one at 360 px. */
export const TILE_GRID_CLASS =
  'grid grid-cols-[repeat(auto-fill,minmax(min(100%,150px),1fr))] gap-3';

/** An account status (`active`, `suspended`, `deleting`) as a badge; suspended accounts stand out. */
export function StatusBadge({ status }: { status?: string }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge
      variant={
        status === 'suspended' ? 'destructive' : status === 'active' ? 'secondary' : 'outline'
      }
    >
      {status}
    </Badge>
  );
}
