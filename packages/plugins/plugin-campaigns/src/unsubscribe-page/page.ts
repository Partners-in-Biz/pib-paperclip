/** The unsubscribe page: confirm, then post the token. No framework, no tracking, no cookies. */
import { apiUrlFrom, readToken, tokenEmail } from "./logic.js";

const card = document.getElementById("card")!;
const title = document.getElementById("title")!;
const detail = document.getElementById("detail")!;
const button = document.getElementById("go") as HTMLButtonElement;

function show(tone: "work" | "ok" | "error", head: string, text: string, showButton = false): void {
  card.setAttribute("data-tone", tone);
  title.textContent = head;
  detail.textContent = text;
  button.hidden = !showButton;
}

const token = readToken(location.search);
const api = apiUrlFrom(location.pathname);

if (!token || !api) {
  show("error", "This link is not complete", "Reply STOP to the message you got and we will stop.");
} else {
  const who = tokenEmail(token);
  show("work", "Unsubscribe", who ? `Stop the emails to ${who} from this sender?` : "Stop these emails from this sender?", true);
  button.addEventListener("click", () => {
    button.disabled = true;
    show("work", "One moment", "Recording it.");
    fetch(api, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })
      .then((res) => {
        if (res.ok) show("ok", "You are unsubscribed", "You will not get these emails again. You can close this page.");
        else show("error", "That did not work", "Reply STOP to the message you got and we will stop.");
      })
      .catch(() => show("error", "That did not work", "Check your connection and try again, or reply STOP to the message you got."))
      .finally(() => {
        button.disabled = false;
      });
  });
}
