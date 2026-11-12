import { useMemo, useRef, useState } from "react";
import { Button, Field, Input, Modal, Select, Tabs, TextArea, fluidColumns, tokens, tone } from "@partnersinbiz/pib-plugin-ui";
import {
  editableViaDraft,
  OVERRIDE_FIELDS,
  PLATFORM_LABELS,
  PLATFORM_LIMITS,
  PRIVACY_OPTIONS,
  SOCIAL_MEDIA_MIME,
  type PlatformOverride,
  type SocialPlatform,
} from "../platforms.js";
import { ExperimentSelect } from "./growth.js";
import { MediaViewer } from "./media-viewer.js";
import { AccountPicker } from "./post-tools.js";
import { NO_ACCOUNT, PostPreview } from "./preview.js";
import { Banner, Muted, PlatformBadge, Row, scopeName, scopeParams, SmallButton, platformLabel, toLocalInput } from "./parts.js";
import type { MediaAsset, Post, RunAction, Snapshot } from "./types.js";

type Overrides = Partial<Record<SocialPlatform, PlatformOverride>>;

const FIELD_LABEL: Record<keyof PlatformOverride, string> = {
  text: "Text",
  title: "Title",
  link: "Link",
  privacy: "Privacy",
  subreddit: "Subreddit",
  boardId: "Board id",
};

/** Upload a file straight to R2 with a presigned PUT, then register it in `client`'s scope (null = own work). */
export async function uploadToR2(run: RunAction, file: File, scope: { client: string | null; space?: "me" }, altText?: string): Promise<MediaAsset> {
  if (!SOCIAL_MEDIA_MIME.includes(file.type)) throw new Error(`${file.name}: use JPEG, PNG, GIF, WebP, MP4 or MOV`);
  const presign = (await run("social.media-presign", { fileName: file.name, mime: file.type, bytes: file.size })) as {
    uploadUrl: string;
    publicUrl: string;
    key: string;
  };
  const put = await fetch(presign.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
  if (!put.ok) throw new Error(`Upload to R2 failed (HTTP ${put.status}). Check the bucket CORS allows this origin.`);
  const dims = await mediaDimensions(file);
  return (await run("social.create-media-asset", {
    url: presign.publicUrl,
    r2Key: presign.key,
    name: file.name,
    mime: file.type,
    bytes: file.size,
    kind: file.type.startsWith("video/") ? "video" : "image",
    width: dims?.width,
    height: dims?.height,
    durationS: dims?.durationS,
    altText: altText || undefined,
    ...scope,
  })) as MediaAsset;
}

function mediaDimensions(file: File): Promise<{ width: number; height: number; durationS?: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const done = (value: { width: number; height: number; durationS?: number } | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    if (file.type.startsWith("image/")) {
      const img = new Image();
      img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => done(null);
      img.src = url;
    } else if (file.type.startsWith("video/")) {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => done({ width: video.videoWidth, height: video.videoHeight, durationS: Math.round(video.duration * 10) / 10 });
      video.onerror = () => done(null);
      video.src = url;
    } else {
      done(null);
    }
  });
}

export function Thumb({ asset, selected, order, onClick, onView }: { asset: { url: string; kind: string; name?: string }; selected?: boolean; order?: number; onClick?: () => void; onView?: () => void }) {
  return (
    <div style={{ position: "relative", width: 84, height: 84, flexShrink: 0 }}>
      <button
        type="button"
        onClick={onClick}
        title={asset.name}
        aria-label={asset.name ?? (asset.kind === "video" ? "Video" : "Image")}
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          padding: 0,
          borderRadius: 10,
          overflow: "hidden",
          border: selected ? `2px solid ${tokens.primary}` : `1px solid ${tokens.border}`,
          background: tokens.secondary,
          cursor: onClick ? "pointer" : "default",
        }}
      >
        {asset.kind === "video" ? (
          <video src={asset.url} muted preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <img src={asset.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        )}
        {asset.kind === "video" ? <span style={{ position: "absolute", left: 4, bottom: 4, fontSize: 10, padding: "1px 5px", borderRadius: 6, background: "rgba(0,0,0,.6)", color: "#fff" }}>▶ video</span> : null}
        {selected && order ? <span style={{ position: "absolute", right: 4, top: 4, fontSize: 11, width: 18, height: 18, borderRadius: 999, background: tokens.primary, color: tokens.primaryFg, display: "grid", placeItems: "center" }}>{order}</span> : null}
      </button>
      {onView ? (
        <button
          type="button"
          onClick={onView}
          aria-label={`View ${asset.name ?? "media"} larger`}
          title="View larger"
          style={{ position: "absolute", right: 4, bottom: 4, width: 24, height: 24, padding: 0, borderRadius: 6, border: "none", background: "rgba(0,0,0,.65)", color: "#fff", fontSize: 13, lineHeight: 1, cursor: "pointer" }}
        >⤢</button>
      ) : null}
    </div>
  );
}

export function Composer({ snapshot, post, run, onClose }: {
  snapshot: Snapshot;
  post: Post | null;
  run: RunAction;
  onClose: () => void;
}) {
  const [body, setBody] = useState(post?.body ?? "");
  // Posts from before strict scopes may target another scope's account: those are dropped on save.
  const foreign = (post?.destinations ?? []).filter((d) => !snapshot.accounts.some((a) => a.id === d.accountId) && d.status !== "published");
  const [accountIds, setAccountIds] = useState<Set<string>>(
    new Set(post?.destinations.map((d) => d.accountId).filter((id) => !foreign.some((d) => d.accountId === id)) ?? []),
  );
  const [mediaIds, setMediaIds] = useState<string[]>(post?.media.map((m) => m.assetId).filter((id): id is string => Boolean(id)) ?? []);
  const [firstComment, setFirstComment] = useState(post?.firstComment ?? "");
  const [replyToUrl, setReplyToUrl] = useState(post?.replyTo?.url ?? "");
  const [quoteUrl, setQuoteUrl] = useState(post?.quote?.url ?? "");
  const [note, setNote] = useState(post?.note ?? "");
  // The proposed publish time: approval schedules the post for it.
  // A failed post's time has passed; going back to draft clears it, so it is not offered again here.
  const [when, setWhen] = useState(post?.scheduledAt && post.status !== "failed" ? toLocalInput(new Date(post.scheduledAt)) : "");
  const [overrides, setOverrides] = useState<Overrides>(post?.overrides ?? {});
  const [overrideTab, setOverrideTab] = useState<string>("");
  const initialTag = post?.experimentId && post.experimentArm ? `${post.experimentId}|${post.experimentArm}` : "";
  const [tag, setTag] = useState(initialTag);
  const [uploading, setUploading] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  // The snapshot holds this scope's accounts and media only: a post never mixes clients.
  const accounts = useMemo(
    () => snapshot.accounts.filter((a) => a.connected && a.status !== "needs_reconnect"),
    [snapshot.accounts],
  );
  const assets = snapshot.media;
  const [extraAssets, setExtraAssets] = useState<MediaAsset[]>([]);
  const allAssets = useMemo(() => {
    const listed = [...extraAssets.filter((e) => !assets.some((a) => a.id === e.id)), ...assets];
    // The post's own media always shows, even when it has dropped off the library's list.
    const own = (post?.media ?? [])
      .filter((m) => m.assetId && !listed.some((a) => a.id === m.assetId))
      .map((m) => ({ id: m.assetId as string, url: m.url, kind: m.kind, name: m.altText ?? "Post media" }));
    return [...own, ...listed];
  }, [assets, extraAssets, post?.media]);
  const [viewing, setViewing] = useState<number | null>(null);
  // Approved, scheduled and failed posts go back to draft on save, never on opening or cancelling.
  const backToDraft = post ? editableViaDraft(post.status) : false;
  const selectedPlatforms = useMemo(() => {
    const set = new Set<SocialPlatform>();
    for (const account of snapshot.accounts) if (accountIds.has(account.id)) set.add(account.platform);
    return [...set];
  }, [snapshot.accounts, accountIds]);
  const activeTab = selectedPlatforms.includes(overrideTab as SocialPlatform) ? (overrideTab as SocialPlatform) : selectedPlatforms[0];

  // An account the post already went out on stays on it.
  const published = useMemo(() => new Set((post?.destinations ?? []).filter((d) => d.status !== "pending" && d.status !== "failed").map((d) => d.accountId)), [post]);
  const toggleAccount = (id: string) => setAccountIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const toggleMedia = (id: string) => setMediaIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const setOverride = (platform: SocialPlatform, field: keyof PlatformOverride, value: string) =>
    setOverrides((prev) => ({ ...prev, [platform]: { ...(prev[platform] ?? {}), [field]: value } }));

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setError("");
    for (const file of Array.from(files)) {
      setUploading(file.name);
      try {
        const asset = await uploadToR2(run, file, scopeParams(snapshot));
        setExtraAssets((prev) => [asset, ...prev]);
        setMediaIds((prev) => [...prev, asset.id]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    setUploading("");
  }

  async function save(sendToReview: boolean) {
    setSaving(true);
    setError("");
    try {
      const cleanOverrides: Overrides = {};
      for (const platform of selectedPlatforms) {
        const entry = overrides[platform];
        if (!entry) continue;
        const kept = Object.fromEntries(Object.entries(entry).filter(([, v]) => typeof v === "string" && v.trim()));
        if (Object.keys(kept).length) cleanOverrides[platform] = kept;
      }
      const [experimentId, arm] = tag ? tag.split("|") : ["", ""];
      // Only send the tag when it changed (an untouched closed experiment stays as history).
      const tagParams = tag === initialTag ? {} : tag ? { experimentId, arm } : { experimentId: "" };
      const params = {
        body,
        accountIds: [...accountIds],
        mediaAssetIds: mediaIds,
        firstComment: firstComment || null,
        // "" clears the reply, quote or note on an existing post.
        replyToUrl: replyToUrl.trim(),
        quoteUrl: quoteUrl.trim(),
        note: note.trim(),
        overrides: cleanOverrides,
        // "" clears a proposed time on an existing post.
        ...(when ? { scheduledAt: new Date(when).toISOString() } : post ? { scheduledAt: "" } : {}),
        ...tagParams,
      };
      if (post && backToDraft) await run("social.back-to-draft", { postId: post.id });
      const saved = (post
        ? await run("social.update-post", { postId: post.id, ...params }, sendToReview ? undefined : "Post saved")
        : await run("social.create-post", { ...params, ...scopeParams(snapshot) }, sendToReview ? undefined : "Draft saved")) as Post;
      if (post) {
        for (const d of post.destinations) {
          if (!accountIds.has(d.accountId) && (d.status === "pending" || d.status === "failed")) await run("social.detach", { postId: post.id, accountId: d.accountId });
        }
      }
      if (sendToReview) await run("social.review", { postId: saved.id }, "Sent for review");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const effectiveText = (platform: SocialPlatform) => overrides[platform]?.text?.trim() || body;
  // The draft as it stands in this form, for the live preview.
  const previewSource = {
    body,
    firstComment,
    overrides,
    media: mediaIds.map((id) => allAssets.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => Boolean(a)).map((a) => ({ url: a.url, kind: a.kind, altText: null })),
  };
  const previewTargets = accounts.filter((a) => accountIds.has(a.id)).map((a) => ({ id: a.id, platform: a.platform, name: a.displayName, handle: a.handle, avatarUrl: a.avatarUrl }));

  return (
    <>
    <Modal
      open
      title={post ? "Edit post" : "New post"}
      description={snapshot.space === "me" ? "Write once, then adjust per platform. Only you can approve, schedule or publish your posts." : "Write once, then adjust per platform. A person, or the scope's delegated approver, approves every post; approval schedules it at the proposed time."}
      onClose={onClose}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="secondary" disabled={saving || !body.trim()} onClick={() => void save(false)}>Save draft</Button>
          {snapshot.space === "me" ? null : (
            <Button type="button" disabled={saving || !body.trim() || accountIds.size === 0} onClick={() => void save(true)}>
              {saving ? "Saving…" : "Save & send for review"}
            </Button>
          )}
        </>
      )}
    >
      {error ? <div role="alert" style={{ fontSize: 12, color: tone("bad").fg }}>{error}</div> : null}
      {post && backToDraft ? (
        <Banner tone="warn" title="Saving moves this post back to draft">
          It is {post.status} now. Once saved it needs approving again before it can publish. Cancel leaves it as it is.
        </Banner>
      ) : null}
      <Muted>For <strong>{scopeName(snapshot)}</strong>. Only this {snapshot.client ? "client's" : "workspace's own"} accounts and media can be used.</Muted>
      <Field label={`Post (${Array.from(body).length} characters)`}>
        <TextArea value={body} onChange={(e) => setBody(e.target.value)} rows={6} placeholder="What do you want to say?" />
      </Field>

      {body.trim() || previewSource.media.length ? (
        <details open style={{ display: "grid", gap: 8 }}>
          <summary style={{ fontSize: 12, color: tokens.muted, fontWeight: 500, cursor: "pointer", marginBottom: 8 }}>Preview: as it will look when posted</summary>
          <PostPreview source={previewSource} accounts={previewTargets.length ? previewTargets : [NO_ACCOUNT]} />
          {previewTargets.length === 0 ? <Muted>Pick accounts below to see each platform's own look.</Muted> : null}
        </details>
      ) : null}

      <div style={{ display: "grid", gap: 6 }}>
        <span style={{ fontSize: 12, color: tokens.muted, fontWeight: 500 }}>Post to</span>
        {accounts.length === 0 ? <Muted>No connected accounts for {scopeName(snapshot)}. Connect one on the Accounts tab.</Muted> : null}
        {foreign.length ? (
          <Muted style={{ color: tone("warn").fg }}>
            {foreign.map((d) => d.accountName).join(", ")} belong{foreign.length === 1 ? "s" : ""} to another client and will be removed from this post when you save.
          </Muted>
        ) : null}
        <AccountPicker
          accounts={accounts}
          selected={accountIds}
          locked={published}
          onToggle={(account) => toggleAccount(account.id)}
          onAll={() => setAccountIds(new Set(accounts.map((a) => a.id)))}
          onNone={() => setAccountIds(new Set(published))}
        />
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        <Row style={{ justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, color: tokens.muted, fontWeight: 500 }}>Media ({mediaIds.length} selected, in order)</span>
          <Row>
            <input ref={fileInput} type="file" multiple accept={SOCIAL_MEDIA_MIME.join(",")} style={{ display: "none" }} onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
            <SmallButton disabled={!snapshot.config.r2 || uploading !== ""} onClick={() => fileInput.current?.click()} title={snapshot.config.r2 ? "" : "Configure R2 in the settings first"}>
              {uploading ? `Uploading ${uploading}…` : "Upload"}
            </SmallButton>
          </Row>
        </Row>
        {allAssets.length === 0 ? <Muted>No media yet. Upload images or an MP4.</Muted> : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", maxHeight: 200, overflow: "auto" }}>
            {allAssets.map((asset) => (
              <Thumb key={asset.id} asset={asset} selected={mediaIds.includes(asset.id)} order={mediaIds.indexOf(asset.id) + 1} onClick={() => toggleMedia(asset.id)} onView={() => setViewing(allAssets.indexOf(asset))} />
            ))}
          </div>
        )}
      </div>

      <Field label={`Proposed publish time (optional, your local time; calendar shows ${snapshot.config.timezone})`}>
        <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </Field>
      <Muted style={{ marginTop: -6 }}>Approving the post schedules it for this time. Without a time, the Social agent picks one after approval.</Muted>

      <ExperimentSelect snapshot={snapshot} value={tag} onChange={setTag} />

      <Field label="First comment (optional)">
        <TextArea value={firstComment} onChange={(e) => setFirstComment(e.target.value)} rows={2} placeholder="Posted as the first comment or reply where the platform allows" />
      </Field>

      <Field label="Reply to an X post (optional)">
        <Input value={replyToUrl} onChange={(e) => setReplyToUrl(e.target.value)} placeholder="https://x.com/handle/status/123…" disabled={Boolean(quoteUrl.trim())} />
      </Field>
      <Field label="Quote an X post (optional)">
        <Input value={quoteUrl} onChange={(e) => setQuoteUrl(e.target.value)} placeholder="https://x.com/handle/status/123…" disabled={Boolean(replyToUrl.trim())} />
      </Field>
      {(replyToUrl.trim() || quoteUrl.trim()) && selectedPlatforms.some((p) => p !== "x") ? (
        <Muted style={{ color: tone("warn").fg }}>Replies and quotes publish on X only. Deselect the other destinations before sending this for review.</Muted>
      ) : null}
      <Field label="Note (optional, internal, never published)">
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="For example: HOLD until PAR-1234" />
      </Field>

      {selectedPlatforms.length ? (
        <div style={{ display: "grid", gap: 8 }}>
          <span style={{ fontSize: 12, color: tokens.muted, fontWeight: 500 }}>Per-platform overrides</span>
          <Tabs tabs={selectedPlatforms.map((p) => ({ id: p, label: PLATFORM_LABELS[p] }))} active={activeTab ?? ""} onChange={setOverrideTab} />
          {activeTab ? (
            <div style={{ display: "grid", gap: 8 }}>
              {OVERRIDE_FIELDS[activeTab].map((field) => {
                const value = overrides[activeTab]?.[field] ?? "";
                if (field === "text") {
                  const length = Array.from(effectiveText(activeTab)).length;
                  const max = PLATFORM_LIMITS[activeTab].maxText;
                  return (
                    <Field key={field} label={`Text for ${PLATFORM_LABELS[activeTab]} (${length}/${max}${value ? "" : ", using the main post"})`}>
                      <TextArea value={value} onChange={(e) => setOverride(activeTab, field, e.target.value)} rows={3} placeholder={body} style={length > max ? { borderColor: "var(--destructive)" } : undefined} />
                    </Field>
                  );
                }
                if (field === "privacy" && PRIVACY_OPTIONS[activeTab]) {
                  return (
                    <Field key={field} label={FIELD_LABEL[field]}>
                      <Select value={value} onChange={(e) => setOverride(activeTab, field, e.target.value)}>
                        <option value="">Default</option>
                        {PRIVACY_OPTIONS[activeTab]!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </Select>
                    </Field>
                  );
                }
                return (
                  <Field key={field} label={FIELD_LABEL[field]}>
                    <Input value={value} onChange={(e) => setOverride(activeTab, field, e.target.value)} placeholder={field === "link" ? "https://…" : field === "subreddit" ? "smallbusiness" : ""} />
                  </Field>
                );
              })}
              <Muted>
                {PLATFORM_LIMITS[activeTab].needsMedia !== "none" ? `${PLATFORM_LABELS[activeTab]} needs ${PLATFORM_LIMITS[activeTab].needsMedia === "any" ? "an image or video" : `a${PLATFORM_LIMITS[activeTab].needsMedia === "image" ? "n image" : " video"}`}. ` : ""}
                Up to {PLATFORM_LIMITS[activeTab].maxMedia} media item{PLATFORM_LIMITS[activeTab].maxMedia === 1 ? "" : "s"}.
              </Muted>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
    {viewing !== null ? <MediaViewer items={allAssets} start={viewing} onClose={() => setViewing(null)} /> : null}
    </>
  );
}
