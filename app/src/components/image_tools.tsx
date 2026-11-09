'use client';

import {
  MAX_OUTPAINT_PIXELS,
  MAX_TOOL_PROMPT_LENGTH,
  TOOL_NAMES,
  type ImageTool,
  type UpscaleMode,
} from '@pictora/core';
import {
  EraserIcon,
  ExpandIcon,
  Loader2Icon,
  ScissorsIcon,
  SparklesIcon,
  WandIcon,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio_group';
import { Textarea } from '@/components/ui/textarea';
import { jobAnnouncement } from '../lib/announcements';
import { versionAltText } from '../lib/edit_options';
import { pointsText, toolsPausedText } from '../lib/generate_options';
import {
  TOOL_MENU,
  UPSCALE_MODE_TEXT,
  choiceToolId,
  outpaintPixels,
  outpaintSize,
  toolCost,
  toolJobRequest,
  toolsOf,
  upscaleModes,
  type OutpaintForm,
  type ToolChoice,
} from '../lib/image_tools';
import type { ImageVersionBody } from '../lib/images';
import { notifyImagesChanged } from '../lib/images_changed';
import type { JobStatusBody, MeBody } from '../lib/jobs';
import { renderMaskPng, type MaskStroke } from '../lib/mask';
import type { ToolCatalog } from '../lib/tool_catalog';
import { browserUploadClient, UploadError, type UploadClient } from '../lib/upload_client';
import { useJobStatus } from '../lib/use_job_status';
import { MaskEditor } from './mask_editor';

const ICONS: Record<ImageTool, LucideIcon> = {
  upscale: SparklesIcon,
  'remove-background': ScissorsIcon,
  erase: EraserIcon,
  outpaint: ExpandIcon,
};

export interface ImageToolsProps {
  imageId: string;
  /** The version the tools run on: the one shown in the image view. */
  version: ImageVersionBody;
  /** The tools the user can run, with their prices (`toolCatalog`). */
  catalog: ToolCatalog;
  /** Called with the new version's number once a tool's job succeeds. */
  onCreated: (version: number) => void;
  /** Sends the erase mask to S3; tests swap it. */
  uploadClient?: UploadClient;
  /** Draws the erase mask as a PNG; tests swap it, since jsdom has no canvas. */
  renderMask?: typeof renderMaskPng;
  /** Polling settings; tests shorten them. */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

/** A tool job started from the menu, followed until it finishes even after its dialog is closed. */
interface RunningTool {
  jobId: string;
  name: string;
  pointsReserved: number;
}

const NETWORK_MESSAGE = 'Something went wrong. Check your connection and try again.';

/**
 * The image view's Tools menu (P1 Image tools, tech design 5.5): upscale, remove background, erase object and
 * outpaint, each in a dialog with its own settings and its cost before it runs. A tool runs on the version shown
 * and makes the image's next version; the job is followed here, so it is announced and the view moves to the new
 * version even if the dialog was closed while it ran.
 */
export function ImageTools({
  imageId,
  version,
  catalog,
  onCreated,
  uploadClient = browserUploadClient,
  renderMask = renderMaskPng,
  pollIntervalMs,
  pollTimeoutMs,
}: ImageToolsProps) {
  const [open, setOpen] = useState<ImageTool>();
  const [running, setRunning] = useState<RunningTool>();
  const [failure, setFailure] = useState<string>();

  const poll = useJobStatus(running?.jobId, {
    intervalMs: pollIntervalMs,
    timeoutMs: pollTimeoutMs,
    onFinish: (job: JobStatusBody) => {
      const name = running?.name ?? 'Tool';
      const [image] = job.images ?? [];
      if (job.status === 'succeeded' && image) {
        notifyImagesChanged();
        toast.success(`${name} done: version ${image.version}`);
        setRunning(undefined);
        setOpen(undefined);
        onCreated(image.version);
        return;
      }
      notifyImagesChanged();
      setFailure(job.error ?? `${name} didn't work. Your points have been refunded.`);
      setRunning(undefined);
    },
  });

  const entries = TOOL_MENU.filter((entry) => toolsOf(catalog.tools, entry.tool).length > 0);
  if (entries.length === 0) return null;
  const busy = running !== undefined;
  const announcement = running
    ? poll.timedOut
      ? `${running.name} is taking longer than usual. The new version will appear in your gallery.`
      : poll.job
        ? jobAnnouncement({
            status: poll.job.status,
            readyText: `${running.name} done`,
            error: poll.job.error,
          }).replace(/^Generating…$/, `${running.name}…`)
        : `${running.name}: starting…`
    : '';

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" disabled={busy}>
            {busy ? (
              <Loader2Icon aria-hidden="true" className="animate-spin" />
            ) : (
              <WandIcon aria-hidden="true" />
            )}
            Tools
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {entries.map((entry) => {
            const Icon = ICONS[entry.tool];
            return (
              <DropdownMenuItem
                key={entry.tool}
                onSelect={() => {
                  setFailure(undefined);
                  setOpen(entry.tool);
                }}
              >
                <Icon aria-hidden="true" />
                {entry.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <p data-slot="tool-announcement" className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <Dialog
        open={open !== undefined}
        onOpenChange={(next) => {
          if (!next) setOpen(undefined);
        }}
      >
        {open && (
          <ToolDialog
            key={`${open}-${version.version}`}
            tool={open}
            imageId={imageId}
            version={version}
            catalog={catalog}
            running={running}
            failure={failure}
            uploadClient={uploadClient}
            renderMask={renderMask}
            onStarted={(started) => {
              setFailure(undefined);
              setRunning(started);
            }}
          />
        )}
      </Dialog>
    </>
  );
}

interface ToolDialogProps {
  tool: ImageTool;
  imageId: string;
  version: ImageVersionBody;
  catalog: ToolCatalog;
  running?: RunningTool;
  failure?: string;
  uploadClient: UploadClient;
  renderMask: typeof renderMaskPng;
  onStarted: (running: RunningTool) => void;
}

/** One tool's dialog: its settings, what it costs against the points left today, and Run. */
function ToolDialog({
  tool,
  imageId,
  version,
  catalog,
  running,
  failure,
  uploadClient,
  renderMask,
  onStarted,
}: ToolDialogProps) {
  const id = useId();
  const entry = TOOL_MENU.find((candidate) => candidate.tool === tool);
  const modes = upscaleModes(catalog.tools);
  const [mode, setMode] = useState<UpscaleMode>(modes[0] ?? 'fast');
  const [prompt, setPrompt] = useState(version.prompt ?? '');
  const [strokes, setStrokes] = useState<MaskStroke[]>([]);
  const [sides, setSides] = useState<OutpaintForm>({ left: 0, right: 0, up: 0, down: 0 });
  const [pointsLeft, setPointsLeft] = useState<number>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/me', { cache: 'no-store' });
        if (!response.ok) return;
        const me = (await response.json()) as MeBody;
        if (!cancelled) setPointsLeft(me.pointsLeft);
      } catch {
        // The cost is still shown without the points left.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const choice: ToolChoice =
    tool === 'upscale'
      ? { tool, mode, prompt }
      : tool === 'erase'
        ? { tool, maskKey: '' }
        : tool === 'outpaint'
          ? { tool, sides, prompt }
          : { tool };
  const toolId = choiceToolId(choice);
  const name = TOOL_NAMES[toolId];
  const cost = toolCost(catalog.tools, toolId);
  const paused = catalog.pausedUntil !== undefined;
  const short = cost !== undefined && pointsLeft !== undefined && cost > pointsLeft;
  const incomplete =
    (tool === 'erase' && strokes.length === 0) ||
    (tool === 'outpaint' && sides.left + sides.right + sides.up + sides.down === 0);
  const busy = sending || running !== undefined;
  const canRun = cost !== undefined && !paused && !short && !incomplete && !busy;
  const takesPrompt = (tool === 'upscale' && mode !== 'fast') || tool === 'outpaint';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRun || cost === undefined) return;
    setSending(true);
    setError(undefined);
    try {
      let submitted = choice;
      if (choice.tool === 'erase') {
        const blob = await renderMask(strokes, version);
        const file = new File([blob], 'mask.png', { type: 'image/png' });
        const ticket = await uploadClient.start(file);
        await uploadClient.send(ticket, file, () => undefined);
        submitted = { tool: 'erase', maskKey: ticket.key };
      }
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toolJobRequest(imageId, version.version, submitted)),
      });
      const body = (await response.json().catch(() => ({}))) as {
        jobId?: string;
        pointsReserved?: number;
        error?: string;
      };
      if (response.status !== 202 || !body.jobId) {
        setError(body.error ?? `We couldn't start ${name}. Please try again.`);
        return;
      }
      notifyImagesChanged();
      onStarted({ jobId: body.jobId, name, pointsReserved: body.pointsReserved ?? cost });
    } catch (caught) {
      setError(caught instanceof UploadError ? caught.message : NETWORK_MESSAGE);
    } finally {
      setSending(false);
    }
  }

  const costLine =
    cost === undefined
      ? `${name} isn't available right now.`
      : pointsLeft === undefined
        ? `Costs ${pointsText(cost)}.`
        : `Costs ${pointsText(cost)} of your ${pointsText(pointsLeft)} left today.`;
  const newSize = outpaintSize(version, sides);

  return (
    <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <DialogHeader>
          <DialogTitle>{entry?.label ?? name}</DialogTitle>
          <DialogDescription>
            {entry?.description} It runs on version {version.version}.
          </DialogDescription>
        </DialogHeader>

        {tool === 'upscale' && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Mode</legend>
            <RadioGroup value={mode} onValueChange={(value) => setMode(value as UpscaleMode)}>
              {modes.map((option) => {
                const optionCost = toolCost(catalog.tools, `upscale-${option}`);
                return (
                  <div key={option} className="flex items-start gap-3">
                    <RadioGroupItem
                      value={option}
                      id={`${id}-${option}`}
                      aria-describedby={`${id}-${option}-detail`}
                      className="mt-0.5"
                    />
                    <div className="flex flex-col gap-0.5">
                      <Label htmlFor={`${id}-${option}`}>
                        {UPSCALE_MODE_TEXT[option].label}
                        {optionCost !== undefined && (
                          <span className="font-normal text-muted-foreground">
                            {' '}
                            · {pointsText(optionCost)}
                          </span>
                        )}
                      </Label>
                      <p id={`${id}-${option}-detail`} className="text-sm text-muted-foreground">
                        {UPSCALE_MODE_TEXT[option].detail}
                      </p>
                    </div>
                  </div>
                );
              })}
            </RadioGroup>
          </fieldset>
        )}

        {tool === 'remove-background' && (
          // eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them
          <img
            src={version.thumbUrl}
            alt={versionAltText(version)}
            width={version.width}
            height={version.height}
            className="h-auto max-h-64 w-full rounded-lg border bg-muted object-contain"
          />
        )}

        {tool === 'erase' && (
          <MaskEditor
            imageUrl={version.url}
            imageAlt={versionAltText(version)}
            width={version.width}
            height={version.height}
            strokes={strokes}
            onStrokesChange={setStrokes}
          />
        )}

        {tool === 'outpaint' && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Extend by (pixels)</legend>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(['left', 'right', 'up', 'down'] as const).map((side) => (
                <div key={side} className="flex flex-col gap-1">
                  <Label htmlFor={`${id}-${side}`} className="capitalize">
                    {side}
                  </Label>
                  <Input
                    id={`${id}-${side}`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={MAX_OUTPAINT_PIXELS}
                    step={1}
                    value={sides[side]}
                    onChange={(event) =>
                      setSides((current) => ({
                        ...current,
                        [side]: outpaintPixels(event.target.value),
                      }))
                    }
                  />
                </div>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              New size: {newSize.width} × {newSize.height}
            </p>
          </fieldset>
        )}

        {takesPrompt && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-prompt`}>Describe the picture (optional)</Label>
            <Textarea
              id={`${id}-prompt`}
              value={prompt}
              maxLength={MAX_TOOL_PROMPT_LENGTH}
              rows={2}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>
        )}

        {paused && catalog.pausedUntil && (
          <Alert>
            <AlertDescription>{toolsPausedText(catalog.pausedUntil)}</AlertDescription>
          </Alert>
        )}
        {(error ?? failure) && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? failure}
          </p>
        )}

        <DialogFooter className="items-center gap-3 sm:justify-between">
          <p data-slot="tool-cost" className="text-sm text-muted-foreground" aria-live="polite">
            {short ? `${costLine} That's more than you have left today.` : costLine}
          </p>
          <Button type="submit" disabled={!canRun}>
            {busy && <Loader2Icon aria-hidden="true" className="animate-spin" />}
            {running
              ? `${running.name}…`
              : sending
                ? 'Starting…'
                : `Run · ${pointsText(cost ?? 0)}`}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
