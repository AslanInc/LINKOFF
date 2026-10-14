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
3. Click **Find my connections**. The page scrolls on its own until everyone has loaded. With a lot of connections this can take a few minutes.
4. **Tap the people you don't know** to select them. A blue checkmark appears. Or tap **☑ Select all**, then untick anyone you want to keep.
5. Tap the red **Remove selected** button. Everyone selected is removed, one after another. Tap **■ Stop** at any time.

Other buttons on each person:
- **✓ Keep**: you know them. Kept people can't be selected or removed, and LinkOff remembers them next time.
- **✕ Remove**: removes just this one person right away.

The tabs at the top sort people into **To review**, **Kept**, and **Removed**, so nobody shows up twice. Tap a photo to see it bigger, or tap **👀 One by one** to go through people one at a time.

### If removing doesn't work

LinkOff first tries LinkedIn's "…" → **Remove connection** menu. If that menu won't open, it asks LinkedIn directly instead, the same request LinkedIn's site sends. Whichever way works is used first for everyone after that, which makes it faster.

If both ways fail, tap **📋 Copy problem details** under the error and send it to whoever is helping you. It says exactly what LinkedIn showed.

### Settings

- **Wait between removals** (default 1–2 s): set it to 0 for the fastest speed, or higher to look more human.
- **Practice mode**: tests everything without removing anyone.

## Things to know

- **Removal is permanent.** To reconnect, you'd have to send a new invite, and LinkedIn doesn't notify people when you remove them.
- **Big batches are risky.** Removing hundreds of people quickly can trigger LinkedIn's limits (LinkOff pauses if LinkedIn says to slow down). Automating actions is also against LinkedIn's User Agreement, so use it at your own risk. Splitting a big list over a few days is safer.
- **English interface only.** LinkOff finds buttons by their English labels ("Remove connection", "Remove").
- **If LinkedIn redesigns the page**, removals may fail. LinkOff stops on its own after 3 failures in a row. Please open an issue if that happens.
