# LinkOff

Remove LinkedIn connections you don't know with one button, instead of opening each person and clicking **More → Remove connection → Remove** yourself.

LinkOff is a Chrome extension. It runs inside your own logged-in LinkedIn tab and clicks those buttons for you. It needs no password and no LinkedIn API key, and it sends nothing anywhere. (LinkedIn's official API doesn't let apps list or remove your connections, so this approach is the only one that works.)

## Install (about 1 minute)

1. Download this repo (green **Code** button → **Download ZIP**) and unzip it.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the `extension` folder.

It also works in Edge, Brave, and other Chromium browsers.

## Use

1. Log in to LinkedIn and open **My Network → Connections**, or click the LinkOff toolbar icon → **Open my connections**.
2. Click the blue **🧹 LinkOff** button in the bottom-right corner.
3. Click **Find my connections**. The page scrolls on its own until everyone has loaded.
4. Each person shows up as a card with a big photo and two big buttons:
   - **✓ Keep**: you know them. Kept people are never removed, and LinkOff remembers them next time.
   - **✕ Remove**: removes just this person. Tap it twice (the first tap asks you to confirm), so a slip can't remove anyone.
5. When you're done, click the red **Remove everyone not kept** button at the bottom.

The tabs at the top sort people into **To review**, **Kept**, and **Removed**. When you keep or remove someone, they leave your To review list, so nobody shows up twice. Changed your mind? Open the **Kept** tab and tap **✓ Kept** to move them back.

**Can't tell who someone is?** Tap their photo to see it full size with their job title. Or click **👀 Review one by one** to go through people one at a time. Tap Keep or Remove and it moves to the next person on its own.

Click **■ Stop** at any time to halt.

### Settings

- **Wait between removals** (default 3–7 s, randomized): slows the clicks down so they look human.
- **Most people to remove at once** (default 100): run it again later to continue.
- **Practice mode**: opens each person's menu without removing anyone, so you can check it works before doing it for real.

## Things to know

- **Removal is permanent.** To reconnect, you'd have to send a new invite, and LinkedIn doesn't notify people when you remove them.
- **Go slow with big lists.** Removing hundreds of people quickly can trigger LinkedIn's rate limits. Automating actions is also against LinkedIn's User Agreement, so use it at your own risk. Keep the default delays and do a few batches a day instead of one huge run.
- **English interface only.** LinkOff finds buttons by their English labels ("Remove connection", "Remove").
- **If LinkedIn redesigns the page**, removals may fail. LinkOff stops on its own after 3 failures in a row. Please open an issue if that happens.
