import { useEffect, useState } from "react";
import {
  useHostLocation,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  Button,
  Input,
  Page,
  PageFrame,
  Form,
  Field,
} from "@partnersinbiz/pib-plugin-ui";
import { parseDialerParams, isDialable, buildDialEvent } from "./dialer.js";

/**
 * Dialer page: dial outbound calls with optional contact context.
 * Reads ?to= and ?contactId= from the URL.
 * Dispatches a dial intent event on the window.
 */
export function DialerPage({ context }: PluginPageProps) {
  const location = useHostLocation();
  const [toNumber, setToNumber] = useState("");
  const [contactId, setContactId] = useState<string | undefined>();

  useEffect(() => {
    const params = parseDialerParams(location.search);
    if (params.to) setToNumber(params.to);
    if (params.contactId) setContactId(params.contactId);
  }, [location.search]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isDialable(toNumber)) {
      window.dispatchEvent(buildDialEvent(toNumber, contactId));
    }
  };

  return (
    <PageFrame>
      <Page title="Dialer" description="Initiate voice calls with contacts">
        <div className="max-w-md mx-auto mt-8 p-6 bg-card rounded-lg border border-border">
          <Form onSubmit={handleSubmit}>
            <Field label="Phone number">
              <Input
                type="tel"
                value={toNumber}
                onChange={(e) => setToNumber(e.currentTarget.value)}
                placeholder="+1234567890"
              />
            </Field>
            {contactId && (
              <Field label="Contact ID">
                <Input type="text" value={contactId} disabled />
              </Field>
            )}
            <div className="flex gap-2 mt-6">
              <Button type="submit" disabled={!isDialable(toNumber)}>
                Call
              </Button>
            </div>
          </Form>
        </div>
      </Page>
    </PageFrame>
  );
}
