// @vitest-environment jsdom
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert_dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown_menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio_group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle_group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

beforeAll(() => {
  // jsdom has neither; Radix's popper and the sidebar's mobile check need them.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      matches: false,
      media,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
  window.matchMedia = globalThis.matchMedia;
});

afterEach(cleanup);

/** One example per file in components/ui, each showing the text it should render. */
const EXAMPLES: Record<string, { text: string; element: ReactNode }> = {
  alert: {
    text: 'Heads up',
    element: (
      <Alert>
        <AlertTitle>Heads up</AlertTitle>
        <AlertDescription>Something happened.</AlertDescription>
      </Alert>
    ),
  },
  alert_dialog: {
    text: 'Delete image?',
    element: (
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete image?</AlertDialogTitle>
            <AlertDialogDescription>This can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  },
  badge: { text: 'New', element: <Badge>New</Badge> },
  button: { text: 'Generate', element: <Button>Generate</Button> },
  card: {
    text: 'Card title',
    element: (
      <Card>
        <CardHeader>
          <CardTitle>Card title</CardTitle>
          <CardDescription>Description</CardDescription>
        </CardHeader>
        <CardContent>Body</CardContent>
      </Card>
    ),
  },
  checkbox: {
    text: 'Enhance prompt',
    element: (
      <label>
        <Checkbox defaultChecked /> Enhance prompt
      </label>
    ),
  },
  dialog: {
    text: 'Image details',
    element: (
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Image details</DialogTitle>
            <DialogDescription>Versions and settings.</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    ),
  },
  dropdown_menu: {
    text: 'Download',
    element: (
      <DropdownMenu open>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Download</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  },
  input: { text: '', element: <Input aria-label="Prompt" defaultValue="A fox" /> },
  popover: {
    text: 'Advanced options',
    element: (
      <Popover open>
        <PopoverTrigger>Options</PopoverTrigger>
        <PopoverContent>Advanced options</PopoverContent>
      </Popover>
    ),
  },
  progress: { text: '', element: <Progress value={40} aria-label="Progress" /> },
  radio_group: {
    text: 'Standard',
    element: (
      <RadioGroup defaultValue="standard">
        <label>
          <RadioGroupItem value="standard" /> Standard
        </label>
      </RadioGroup>
    ),
  },
  select: {
    text: 'Gemini',
    element: (
      <Select defaultValue="gemini">
        <SelectTrigger aria-label="Model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="gemini">Gemini</SelectItem>
        </SelectContent>
      </Select>
    ),
  },
  separator: { text: '', element: <Separator /> },
  sheet: {
    text: 'Navigation',
    element: (
      <Sheet open>
        <SheetContent>
          <SheetTitle>Navigation</SheetTitle>
          <SheetDescription>Pages</SheetDescription>
        </SheetContent>
      </Sheet>
    ),
  },
  sidebar: {
    text: 'Gallery',
    element: (
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton>Gallery</SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuSkeleton showIcon />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
        <SidebarTrigger />
      </SidebarProvider>
    ),
  },
  skeleton: { text: '', element: <Skeleton className="h-4 w-20" /> },
  sonner: { text: '', element: <Toaster /> },
  table: {
    text: 'Spend',
    element: (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Spend</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>$1.00</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    ),
  },
  textarea: { text: '', element: <Textarea aria-label="Describe" /> },
  toggle: { text: 'Bold', element: <Toggle>Bold</Toggle> },
  toggle_group: {
    text: '16:9',
    element: (
      <ToggleGroup type="single" defaultValue="16:9">
        <ToggleGroupItem value="1:1">1:1</ToggleGroupItem>
        <ToggleGroupItem value="16:9">16:9</ToggleGroupItem>
      </ToggleGroup>
    ),
  },
  tooltip: {
    text: 'Points per image',
    element: (
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Cost</TooltipTrigger>
          <TooltipContent>Points per image</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ),
  },
};

describe('components/ui', () => {
  it('has an example for every component file, all named in snake_case', () => {
    // jsdom tests have an http import.meta.url, so this resolves from the app workspace, where Vitest runs.
    const files = readdirSync(resolve(process.cwd(), 'src/components/ui'));
    expect(files.every((file) => /^[a-z]+(_[a-z]+)*\.tsx$/.test(file))).toBe(true);
    expect(files.map((file) => file.replace(/\.tsx$/, '')).sort()).toEqual(
      Object.keys(EXAMPLES).sort(),
    );
  });

  it.each(Object.entries(EXAMPLES))('renders %s', (name, { text, element }) => {
    const { baseElement } = render(element);
    if (text) expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    // shadcn components mark their parts with data-slot (Sonner's toaster renders nothing until a toast).
    if (name !== 'sonner') expect(baseElement.querySelector('[data-slot]')).not.toBeNull();
  });
});
