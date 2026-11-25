import { AgentAvatar, type AvatarAgent } from "../AgentAvatar";
import { useCallback, useContext, useState } from "react";
import { Pencil } from "lucide-react";
import type { IssueAttachment } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { FoldCurtain } from "@/components/FoldCurtain";
import { InlineEditor } from "@/components/InlineEditor";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "@/components/MarkdownBody";
import {
  ImageGalleryModal,
  type GalleryMediaItem,
} from "@/components/ImageGalleryModal";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { ArtifactPreview } from "@/components/artifacts/ArtifactCard";
import { ArtifactRow, ArtifactRowGroup, inlineRowStyle, subjectFromAttachmentRef } from "@/components/artifacts/v1";
import { IssueGalleryContext } from "@/context/IssueGalleryContext";
import { TextAttachmentContext } from "@/context/TextAttachmentContext";
import { useArtifactsV1Enabled } from "@/hooks/useArtifactsV1Enabled";
import { isTextAttachment } from "@/lib/issue-attachments";
import { isVideoLikeOutput } from "@/lib/issue-output";
import type { MentionOption } from "@/components/MarkdownEditor";
import { formatTaskChatTimestamp } from "./task-chat-adapter";
import {
  extractAttachmentRefs,
  extractImageRefs,
  fileKindForAttachment,
  formatFileSize,
  hydrateAttachmentRefs,
  isImageAttachment,
  stripStandaloneImageEmbeds,
  type AttachmentRef,
} from "./task-chat-attachments";
import { useCoordinatorPresentation } from "../coordinator/CoordinatorPresentation";
import { CoordinatorRelativeTime } from "../coordinator/CoordinatorRelativeTime";

/**
 * Host binding for the description-as-first-bubble (PAP-375): the LIVE issue
 * description plus everything the edit surface needs. Carried on the shared
 * thread props (`issueBrief`); only the redesigned TaskChatThread consumes it.
 */
export interface TaskChatIssueBrief {
  /** LIVE issue.description (never a frozen copy) — empty string when unset. */
  description: string;
  /** Originating actor: human-created → blue user bubble, agent-created → agent-side bubble. */
  author: "human" | "agent";
  /** Creating agent's name, shown in the agent-side avatar header. */
  authorName?: string;
  /** Creating agent's assigned icon (AgentIconName) for the avatar header. */
  agentIcon?: string | null;
  agent?: AvatarAgent;
  /** issue.createdAt — rendered like the other bubbles' footer timestamps. */
  createdAt?: string | Date;
  onSave: (description: string) => void | Promise<unknown>;
  mentions?: MentionOption[];
  externalReferences?: MarkdownExternalReferenceMap;
  imageUploadHandler?: (file: File) => Promise<string>;
  onDropFile?: (file: File) => Promise<void>;
}

interface TaskChatDescriptionBubbleProps {
  brief: TaskChatIssueBrief;
  attachments?: IssueAttachment[];
}

/** ~12 text-sm lines (20px line-height) — the accepted fold default (PAP-375). */
const FOLD_COLLAPSED_HEIGHT_PX = 240;

function galleryItemForMedia(
  src: string,
  name?: string,
  attachment?: ReturnType<typeof hydrateAttachmentRefs>[number],
): GalleryMediaItem {
  return {
    id: attachment?.id ?? src,
    contentPath: attachment?.openPath ?? src,
    openPath: attachment?.openPath,
    downloadPath: attachment?.downloadPath,
    contentType: attachment?.contentType ?? "",
    originalFilename: name?.trim() ? name : "image",
  };
}

function uniqueAttachmentRefs(refs: AttachmentRef[]): AttachmentRef[] {
  return refs.filter(
    (ref, index) =>
      refs.findIndex(
        (candidate) =>
          (ref.id && candidate.id === ref.id) || candidate.url === ref.url,
      ) === index,
  );
}

/**
 * The task description as the requester's first chat bubble (PAP-375):
 * human-created tasks get the blue user bubble, agent-created tasks the
 * agent-side card with the avatar header — same chrome as TaskChatBubble. The
 * body is the live issue.description. Human-authored blue bubbles are
 * presentation-only; agent-authored descriptions retain the hover edit
 * affordance. Long descriptions fold at ~12 lines behind a Show more curtain;
 * an empty description renders a muted ghost row that opens the editor — never
 * an empty bubble.
 */
export function TaskChatDescriptionBubble({
  brief,
  attachments = [],
}: TaskChatDescriptionBubbleProps) {
  const coordinator = useCoordinatorPresentation();
  const { enabled: artifactsV1 } = useArtifactsV1Enabled();
  const openText = useContext(TextAttachmentContext);
  const openIssueGallery = useContext(IssueGalleryContext);
  const [editing, setEditing] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const openImage = useCallback(
    (src: string) => {
      if (!openIssueGallery?.(src)) setLightboxSrc(src);
    },
    [openIssueGallery],
  );
  const isHuman = brief.author === "human";
  const { refs: linkedRefs, text: bodyWithoutAttachmentLinks } =
    extractAttachmentRefs(brief.description);
  const embeddedImageRefs = extractImageRefs(bodyWithoutAttachmentLinks);
  const bodyText = stripStandaloneImageEmbeds(bodyWithoutAttachmentLinks);
  const hydratedLinkedRefs = hydrateAttachmentRefs(linkedRefs, attachments);
  const hydratedEmbeddedRefs = hydrateAttachmentRefs(
    embeddedImageRefs,
    attachments,
  );
  const imageRefs = uniqueAttachmentRefs([
    ...hydratedEmbeddedRefs,
    ...hydratedLinkedRefs.filter(isImageAttachment),
  ]);
  const attachmentRefs = uniqueAttachmentRefs(
    hydratedLinkedRefs.filter((ref) => !isImageAttachment(ref)),
  );
  const mediaRefs = [
    ...imageRefs,
    ...attachmentRefs.filter((ref) => isVideoLikeOutput(ref.contentType, ref.name)),
  ];
  const galleryItems: GalleryMediaItem[] =
    lightboxSrc !== null && !mediaRefs.some((ref) => ref.url === lightboxSrc)
      ? [galleryItemForMedia(lightboxSrc)]
      : mediaRefs.map((ref) => galleryItemForMedia(ref.url, ref.name, ref));
  const lightboxIndex =
    lightboxSrc === null
      ? -1
      : Math.max(0, mediaRefs.findIndex((ref) => ref.url === lightboxSrc));
  const hasDescription =
    bodyText.length > 0 || imageRefs.length > 0 || attachmentRefs.length > 0;

  if (editing) {
    return (
      <div
        className="tc-enter-bubble w-full rounded-lg border border-border bg-card px-2 py-1"
        data-testid="task-chat-description-editor"
      >
        <InlineEditor
          value={brief.description}
          onSave={brief.onSave}
          as="p"
          className="text-sm leading-7 text-foreground"
          placeholder="Add a description..."
          multiline
          defaultEditing
          onEditingChange={(next) => {
            if (!next) setEditing(false);
          }}
          mentions={brief.mentions}
          externalReferences={brief.externalReferences}
          imageUploadHandler={brief.imageUploadHandler}
          onDropFile={brief.onDropFile}
        />
      </div>
    );
  }

  if (!hasDescription) {
    // Accepted default: no fabricated empty bubble — a muted ghost affordance.
    return (
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1.5 text-left text-sm text-muted-foreground/70 transition-colors hover:bg-accent/20 hover:text-muted-foreground"
        onClick={() => setEditing(true)}
        data-testid="task-chat-description-ghost"
      >
        <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Add a description...
      </button>
    );
  }

  const timestamp = coordinator && brief.createdAt
    ? <CoordinatorRelativeTime value={brief.createdAt} />
    : formatTaskChatTimestamp(brief.createdAt);
  return (
    <div
      className={cn(
        "tc-enter-bubble group/brief flex w-full flex-col gap-1",
        isHuman ? "items-end" : "items-start",
      )}
      data-testid="task-chat-description-bubble"
      data-author={brief.author}
    >
      {!isHuman && brief.authorName ? (
        <span className="flex items-center gap-2 px-1">
          <AgentAvatar agent={brief.agent} name={brief.authorName} size={24} />
          <span className="text-sm font-semibold text-foreground">{brief.authorName}</span>
        </span>
      ) : null}
      {bodyText.length > 0 ? (
        <div
          className={cn(
            "flex w-full items-start gap-1.5",
            isHuman ? "flex-row-reverse" : "flex-row",
          )}
        >
          <div
            className={cn(
              "max-w-(--pct-85) break-words px-3.5 py-2 text-sm",
              isHuman
                ? "rounded-2xl rounded-br-sm bg-(--liveness-blue) text-white"
                : "rounded-2xl rounded-bl-sm bg-(--bubble-agent) text-foreground",
            )}
          >
            <FoldCurtain
              collapsedHeight={FOLD_COLLAPSED_HEIGHT_PX}
              // The curtain's fade is a mask (background-agnostic); only the
              // toggle's muted colors need a lift on the solid blue bubble.
              toggleClassName={isHuman ? "text-white/80 hover:text-white hover:bg-white/10" : undefined}
            >
              <MarkdownBody
                // On the solid --liveness-blue human bubble, keep prose body text
                // following the bubble's `text-white` in both themes.
                className={isHuman ? "paperclip-markdown-on-accent" : undefined}
                softBreaks
                linkIssueReferences
                externalReferences={brief.externalReferences}
                onImageClick={openImage}
              >
                {bodyText}
              </MarkdownBody>
            </FoldCurtain>
          </div>
          {!isHuman ? (
            <button
              type="button"
              className="mt-1 shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent/50 hover:text-foreground focus-visible:opacity-100 group-hover/brief:opacity-100"
              onClick={() => setEditing(true)}
              aria-label="Edit description"
              data-testid="task-chat-description-edit"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
      {!artifactsV1 && imageRefs.length > 0 ? (
        <div
          className="flex max-w-(--pct-85) flex-col gap-2"
          data-testid="task-chat-description-media"
        >
          <span className="text-xs text-muted-foreground">
            Images · {imageRefs.length}
          </span>
          <div className="grid grid-cols-4 gap-2">
            {imageRefs
              .slice(0, imageRefs.length > 4 ? 3 : 4)
              .map((ref, index) => (
                <button
                  key={ref.url}
                  type="button"
                  className="group aspect-video min-w-0 overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Open ${ref.name || `image ${index + 1}`}`}
                  onClick={() => openImage(ref.url)}
                >
                  <img
                    src={ref.openPath ?? ref.url}
                    alt={ref.name}
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform group-hover:scale-(--s-1_02)"
                  />
                </button>
              ))}
            {imageRefs.length > 4 ? (
              <button
                type="button"
                className="aspect-video min-w-0 rounded-md bg-muted text-sm font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Open ${imageRefs.length - 3} more screenshots`}
                onClick={() => openImage(imageRefs[3].url)}
              >
                +{imageRefs.length - 3}
              </button>
            ) : null}
          </div>
          <span className="truncate text-xs text-muted-foreground">
            {imageRefs.map((ref) => ref.name || "image").join(" · ")}
          </span>
        </div>
      ) : null}
      {!artifactsV1 && attachmentRefs.length > 0 ? (
        <div className="flex max-w-(--pct-85) flex-col gap-2">
          <span className="text-xs text-muted-foreground">
            Files · {attachmentRefs.length}
          </span>
          <AttachmentGroup data-testid="task-chat-description-attachments">
            {attachmentRefs.map((ref) => {
              const kind = fileKindForAttachment(ref);
              const KindIcon = kind.icon;
              const size = formatFileSize(ref.byteSize);
              const video = isVideoLikeOutput(ref.contentType, ref.name);
              return (
                <Attachment key={ref.url} size="sm">
                  <AttachmentMedia className={video ? "aspect-video group-data-[size=sm]/attachment:w-20" : undefined}>
                    {video ? <ArtifactPreview artifact={{ title: ref.name, contentPath: ref.openPath ?? ref.url, mediaKind: "video" }} /> : <KindIcon aria-hidden />}
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle className="max-w-48">
                      {ref.name}
                    </AttachmentTitle>
                    <AttachmentDescription className="max-w-48">
                      {size ? `${kind.label} · ${size}` : kind.label}
                    </AttachmentDescription>
                  </AttachmentContent>
                  <AttachmentTrigger
                    aria-label={`Open ${ref.name}`}
                    onClick={video ? () => openImage(ref.url) : undefined}
                    render={video ? <button type="button" /> :
                      <a
                        href={ref.openPath ?? ref.url}
                        onClick={(event) => {
                          if (openText && ref.id && isTextAttachment({ contentType: ref.contentType ?? "", originalFilename: ref.name }) && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                            event.preventDefault(); openText(ref.id, ref.name);
                          }
                        }}
                        target="_blank"
                        rel="noreferrer"
                      />
                    }
                  />
                </Attachment>
              );
            })}
          </AttachmentGroup>
        </div>
      ) : null}
      {timestamp ? (
        <span className="px-1 text-(length:--text-micro) text-muted-foreground">{timestamp}</span>
      ) : null}
      {artifactsV1 && imageRefs.length + attachmentRefs.length > 0 ? (
        <div className="w-full pt-2" data-testid="task-chat-description-artifacts-v1">
          <ArtifactRowGroup>
            {[...imageRefs, ...attachmentRefs].map((ref) => {
              const subject = subjectFromAttachmentRef(ref);
              const picture = isImageAttachment(ref) || isVideoLikeOutput(ref.contentType, ref.name);
              const textTab = Boolean(openText && ref.id && isTextAttachment({ contentType: ref.contentType ?? "", originalFilename: ref.name }));
              if (picture) return <ArtifactRow key={ref.url} subject={subject} onClick={() => openImage(ref.url)} style={inlineRowStyle} />;
              if (textTab) return <ArtifactRow key={ref.url} subject={subject} href={ref.openPath ?? ref.url} external onClick={() => openText?.(ref.id!, ref.name)} style={inlineRowStyle} />;
              return <ArtifactRow key={ref.url} subject={subject} href={ref.openPath ?? ref.url} external style={inlineRowStyle} />;
            })}
          </ArtifactRowGroup>
        </div>
      ) : null}
      {lightboxSrc !== null && lightboxIndex >= 0 ? (
        <ImageGalleryModal
          items={galleryItems}
          initialIndex={lightboxIndex}
          open
          onOpenChange={(open) => {
            if (!open) setLightboxSrc(null);
          }}
        />
      ) : null}
    </div>
  );
}
