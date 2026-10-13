import { useEffect, useState } from "react";
import { usePluginAction, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import type { TelephonySettings, FieldError } from "../settings.js";

export function TelephonySettingsPage(_props: PluginPageProps) {
  const [data, setData] = useState<{ settings: TelephonySettings; secretsStatus: Record<string, "set" | "missing"> } | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncingSent, setSyncingSent] = useState(false);

  const get = usePluginAction("telephony.settings.get");
  const save = usePluginAction("telephony.settings.save");
  const syncTemplates = usePluginAction("telephony.settings.sync-templates");

  useEffect(() => {
    get({})
      .then((result: any) => {
        setData(result);
        setErrors([]);
        setErrorMessage(null);
      })
      .catch((err: any) => {
        setErrorMessage("Failed to load telephony settings. Please try again.");
        setData(null);
      });
  }, []);

  if (!data) return <div className="p-4">{errorMessage ? <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{errorMessage}</div> : "Loading..."}</div>;

  const settings = data.settings;
  const secretsStatus = data.secretsStatus || {};

  const handleChange = (field: string, value: any) => {
    setData((prev) => {
      if (!prev) return prev;
      const keys = field.split(".");
      const newSettings = JSON.parse(JSON.stringify(prev.settings));
      let current = newSettings;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]]) current[keys[i]] = {};
        current = current[keys[i]];
      }
      current[keys[keys.length - 1]] = value;
      return { ...prev, settings: newSettings };
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setErrorMessage(null);
    try {
      const result: any = await save(data.settings as unknown as Record<string, unknown>);
      if (result.ok) {
        setErrors([]);
        setErrorMessage(null);
      } else {
        setErrors(result.errors || []);
        setErrorMessage(null);
      }
    } catch (err: any) {
      setErrorMessage("Failed to save settings. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleSync = async () => {
    setSyncingSent(true);
    setErrorMessage(null);
    try {
      await syncTemplates({});
      await get({}).then((result: any) => {
        setData(result);
        setErrorMessage(null);
      });
    } catch (err: any) {
      setErrorMessage("Failed to request template sync. Please try again.");
    } finally {
      setSyncingSent(false);
    }
  };

  const getFieldError = (field: string) => errors.find((e) => e.field === field)?.message;

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      {errorMessage && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{errorMessage}</div>}

      <div>
        <h1 className="text-2xl font-bold">Telephony Settings</h1>
        <p className="text-gray-600">Configure voice, SMS, and WhatsApp messaging.</p>
      </div>

      {/* Recording */}
      <div className="border rounded p-4 space-y-3">
        <label className="flex items-center space-x-2">
          <input
            type="checkbox"
            checked={settings.recordingEnabled}
            onChange={(e) => handleChange("recordingEnabled", e.target.checked)}
            className="rounded"
          />
          <span className="font-medium">Enable call recording</span>
        </label>
      </div>

      {/* Allowed Hours */}
      <div className="border rounded p-4 space-y-3">
        <h3 className="font-semibold">Allowed call hours (SAST)</h3>
        {["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].map((day) => (
          <div key={day} className="flex items-end gap-2">
            <label className="flex-1">
              <span className="block text-sm font-medium capitalize">{day}</span>
              <div className="flex gap-2 mt-1">
                <input
                  type="text"
                  placeholder="HH:MM"
                  value={settings.allowedHours[day as keyof typeof settings.allowedHours]?.start || ""}
                  onChange={(e) => handleChange(`allowedHours.${day}.start`, e.target.value)}
                  maxLength={5}
                  className="w-20 px-2 py-1 border rounded"
                />
                <span className="py-1">to</span>
                <input
                  type="text"
                  placeholder="HH:MM"
                  value={settings.allowedHours[day as keyof typeof settings.allowedHours]?.end || ""}
                  onChange={(e) => handleChange(`allowedHours.${day}.end`, e.target.value)}
                  maxLength={5}
                  className="w-20 px-2 py-1 border rounded"
                />
              </div>
              {getFieldError(`allowedHours.${day}`) && <p className="text-red-600 text-sm mt-1">{getFieldError(`allowedHours.${day}`)}</p>}
            </label>
          </div>
        ))}
      </div>

      {/* Caller IDs */}
      <div className="border rounded p-4 space-y-3">
        <h3 className="font-semibold">Caller IDs (E.164 format, optional)</h3>
        {["za", "us"].map((country) => (
          <label key={country}>
            <span className="block text-sm font-medium uppercase mb-1">{country}</span>
            <input
              type="text"
              placeholder="+11234567890"
              value={settings.callerIds[country as "za" | "us"] || ""}
              onChange={(e) => handleChange(`callerIds.${country}`, e.target.value)}
              className="w-full px-2 py-1 border rounded"
            />
            {getFieldError(`callerIds.${country}`) && <p className="text-red-600 text-sm mt-1">{getFieldError(`callerIds.${country}`)}</p>}
          </label>
        ))}
      </div>

      {/* Caps */}
      <div className="border rounded p-4 space-y-3">
        <h3 className="font-semibold">Usage limits (0–10000)</h3>
        <label>
          <span className="block text-sm font-medium mb-1">Calls per day</span>
          <input
            type="number"
            value={settings.caps.callsPerDay}
            onChange={(e) => handleChange("caps.callsPerDay", Number(e.target.value))}
            min="0"
            max="10000"
            className="w-full px-2 py-1 border rounded"
          />
          {getFieldError("caps.callsPerDay") && <p className="text-red-600 text-sm mt-1">{getFieldError("caps.callsPerDay")}</p>}
        </label>
        <label>
          <span className="block text-sm font-medium mb-1">Messages per day</span>
          <input
            type="number"
            value={settings.caps.messagesPerDay}
            onChange={(e) => handleChange("caps.messagesPerDay", Number(e.target.value))}
            min="0"
            max="10000"
            className="w-full px-2 py-1 border rounded"
          />
          {getFieldError("caps.messagesPerDay") && <p className="text-red-600 text-sm mt-1">{getFieldError("caps.messagesPerDay")}</p>}
        </label>
      </div>

      {/* TenDLC Status */}
      <div className="border rounded p-4 space-y-3">
        <h3 className="font-semibold">10DLC Status</h3>
        <select value={settings.tenDlcStatus} onChange={(e) => handleChange("tenDlcStatus", e.target.value)} className="w-full px-2 py-1 border rounded">
          <option value="unknown">Unknown</option>
          <option value="not_started">Not started</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {/* Secrets */}
      <div className="border rounded p-4 space-y-3">
        <h3 className="font-semibold">API credentials</h3>
        <p className="text-sm text-gray-600">allowlistUserIds is stored but not yet enforced by call/message actions. Enforcement lands with the click-to-call PR.</p>
        <div className="space-y-2">
          {Object.entries(secretsStatus).map(([key, status]) => (
            <div key={key} className="flex items-center justify-between">
              <span className="text-sm">{key}</span>
              <span className={`text-xs font-medium ${status === "set" ? "text-green-600" : "text-gray-500"}`}>{status}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 justify-between">
        <button
          onClick={handleSync}
          disabled={syncingSent}
          className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300 disabled:opacity-50"
        >
          Request template sync
        </button>
        <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

export default TelephonySettingsPage;
