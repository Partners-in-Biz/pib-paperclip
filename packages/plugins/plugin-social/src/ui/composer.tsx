import { useMemo, useRef, useState } from "react";
import { Button, Field, Input, Modal, Select, Tabs, TextArea, tokens } from "@partnersinbiz/pib-plugin-ui";
import {
  OVERRIDE_FIELDS,
  PLATFORM_LABELS,
  PLATFORM_LIMITS,
  PRIVACY_OPTIONS,
  SOCIAL_MEDIA_MIME,
  type PlatformOverride,
  type SocialPlatform,
} from "../platforms.js";
import { ExperimentSelect } from "./growth.js";
import { Avatar, Muted, Row, scopeName, scopeParams, SmallButton, platformLabel } from "./parts.js";
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
export async function uploadToR2(run: RunAction, file: File, client: string | null, altText?: string): Promise<MediaAsset> {
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
    client,
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

export function Thumb({ asset, selected, order, onClick }: { asset: { url: string; kind: string; name?: string }; selected?: boolean; order?: number; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={asset.name}
      style={{
        position: "relative",
        width: 84,
        height: 84,
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
      {asset.kind === "video" ? <span style={{ position: "absolute", left: 4, bottom: 4, fontSize: 10, padding: "1px 5px", borderRadius: 6, background: "rgba(0,0,0,.6)", color: "#fff" }}>video</span> : null}
      {selected && order ? <span style={{ position: "absolute", right: 4, top: 4, fontSize: 11, width: 18, height: 18, borderRadius: 999, background: tokens.primary, color: tokens.primaryFg, display: "grid", placeItems: "center" }}>{order}</span> : null}
    </button>
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
  const allAssets = useMemo(() => [...extraAssets.filter((e) => !assets.some((a) => a.id === e.id)), ...assets], [assets, extraAssets]);
  const selectedPlatforms = useMemo(() => {
    const set = new Set<SocialPlatform>();
    for (const account of snapshot.accounts) if (accountIds.has(account.id)) set.add(account.platform);
    return [...set];
  }, [snapshot.accounts, accountIds]);
  const activeTab = selectedPlatforms.includes(overrideTab as SocialPlatform) ? (overrideTab as SocialPlatform) : selectedPlatforms[0];

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
        const asset = await uploadToR2(run, file, snapshot.scope);
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
        overrides: cleanOverrides,
        ...tagParams,
      };
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

  return (
    <Modal
      open
      title={post ? "Edit post" : "New post"}
      description="Write once, then adjust per platform. A person approves before anything is scheduled."
      onClose={onClose}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="secondary" disabled={saving || !body.trim()} onClick={() => void save(false)}>Save draft</Button>
          <Button type="button" disabled={saving || !body.trim() || accountIds.size === 0} onClick={() => void save(true)}>
            {saving ? "Saving…" : "Save & send for review"}
          </Button>
        </>
      )}
    >
      {error ? <div role="alert" style={{ fontSize: 12, color: "var(--destructive)" }}>{error}</div> : null}
      <Muted>For <strong>{scopeName(snapshot)}</strong>. Only this {snapshot.client ? "client's" : "workspace's own"} accounts and media can be used.</Muted>
      <Field label={`Post (${Array.from(body).length} characters)`}>
        <TextArea value={body} onChange={(e) => setBody(e.target.value)} rows={6} placeholder="What do you want to say?" />
      </Field>

      <div style={{ display: "grid", gap: 6 }}>
        <span style={{ fontSize: 12, color: tokens.muted, fontWeight: 500 }}>Destinations</span>
        {accounts.length === 0 ? <Muted>No connected accounts for {scopeName(snapshot)}. Connect one on the Accounts tab.</Muted> : null}
        {foreign.length ? (
          <Muted style={{ color: "#b45309" }}>
            {foreign.map((d) => d.accountName).join(", ")} belong{foreign.length === 1 ? "s" : ""} to another client and will be removed from this post when you save.
          </Muted>
        ) : null}
        <div style={{ display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
          {accounts.map((account) => (
            <label key={account.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 8px", borderRadius: 10, border: `1px solid ${accountIds.has(account.id) ? tokens.primary : tokens.border}`, cursor: "pointer" }}>
              <input type="checkbox" checked={accountIds.has(account.id)} onChange={() => toggleAccount(account.id)} />
              <Avatar url={account.avatarUrl} label={account.displayName} />
              <span style={{ display: "grid", minWidth: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.displayName}</span>
                <Muted style={{ fontSize: 11 }}>{platformLabel(account.platform)}</Muted>
              </span>
            </label>
          ))}
        </div>
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
              <Thumb key={asset.id} asset={asset} selected={mediaIds.includes(asset.id)} order={mediaIds.indexOf(asset.id) + 1} onClick={() => toggleMedia(asset.id)} />
            ))}
          </div>
        )}
      </div>

      <ExperimentSelect snapshot={snapshot} value={tag} onChange={setTag} />

      <Field label="First comment (optional)">
        <TextArea value={firstComment} onChange={(e) => setFirstComment(e.target.value)} rows={2} placeholder="Posted as the first comment or reply where the platform allows" />
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
  );
}
