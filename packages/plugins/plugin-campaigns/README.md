# Campaigns

Paperclip plugin `partnersinbiz.campaigns`. Themed email programs that enroll contacts and open a Paperclip issue for each due step.

- A campaign groups email steps that target an audience. `audienceTags` narrows which contacts are enrolled; empty means every visible contact.
- `launch-campaign` enrolls matching contacts (read from the CRM plugin) and opens the first step's issue. A person sends the email and marks the issue done.
- `pause-campaign`, `resume-campaign`, and `complete-campaign` control a running program.
- `campaign-stats` reports enrolled, running, and completed counts.

The plugin reads contacts from the CRM plugin's namespace to build the audience. Install both plugins together.
