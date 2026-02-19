import { chromium } from "playwright";

const SESSION_ID = "5d4f141e-a00d-466b-ba02-a65a7776e532";

async function testChatFeatures() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Capture all console messages
  page.on("console", (msg) => {
    console.log(`[Browser ${msg.type()}]: ${msg.text()}`);
  });

  // Capture page errors
  page.on("pageerror", (error) => {
    console.log(`[Page Error]: ${error.message}`);
  });

  console.log("=== Testing Chat Panel Features ===\n");

  // Navigate to the training run page
  console.log("1. Navigating to training run page...");
  await page.goto(`http://localhost:5173/runs/${SESSION_ID}`, {
    waitUntil: "domcontentloaded",
  });

  // Wait for React to render - look for key elements
  console.log("   Waiting for page to render...");
  try {
    // Wait for either the session header or an error message
    await page.waitForSelector('h1, .error, [class*="spinner"]', {
      timeout: 10000,
    });
  } catch (e) {
    console.log("   Timeout waiting for initial content");
  }

  // Wait a bit more for full render
  await page.waitForTimeout(3000);

  // Take screenshot
  await page.screenshot({ path: "/tmp/debug-page.png", fullPage: true });
  console.log("   Screenshot saved to /tmp/debug-page.png");

  // Get page info
  console.log(`   URL: ${page.url()}`);
  const bodyHTML = await page.locator("body").innerHTML();
  console.log(`   Body HTML length: ${bodyHTML.length}`);
  console.log(`   Body preview: ${bodyHTML.substring(0, 500)}`);

  // Wait for the specific session content to load
  console.log("\n2. Waiting for session details...");
  try {
    // Wait for the session header that shows "project / experiment"
    await page.waitForSelector('h1:has-text("/")', { timeout: 15000 });
    console.log("   Session header found");
  } catch (e) {
    console.log("   Session header not found, checking for loading state...");
    const loadingText = await page.locator("text=Loading").count();
    const errorText = await page.locator("text=Error").count();
    console.log(
      `   Loading elements: ${loadingText}, Error elements: ${errorText}`,
    );
  }

  // Find all buttons now
  console.log("\n3. Finding all buttons...");
  const allButtons = await page.locator("button").all();
  console.log(`   Total buttons found: ${allButtons.length}`);

  for (let i = 0; i < Math.min(allButtons.length, 15); i++) {
    try {
      const text = await allButtons[i].textContent();
      const isVisible = await allButtons[i].isVisible();
      console.log(
        `   Button ${i}: "${text?.trim().substring(0, 50)}" (visible: ${isVisible})`,
      );
    } catch (e) {
      console.log(`   Button ${i}: [error reading]`);
    }
  }

  // Clear localStorage first to ensure clean test state
  console.log("\n4. Clearing localStorage for clean test...");
  await page.evaluate((sessionId) => {
    localStorage.removeItem(`rllm_chat_messages_${sessionId}`);
  }, SESSION_ID);
  console.log("   localStorage cleared");

  // Try to find the Assistant button
  console.log("\n5. Switching to Assistant view...");

  let assistantButton = page
    .locator("button")
    .filter({ hasText: /Assistant/i });
  let count = await assistantButton.count();
  console.log(`   Buttons with 'Assistant': ${count}`);

  if (count === 0) {
    // Maybe the text is just in a child element
    assistantButton = page.locator('button:has-text("Assistant")');
    count = await assistantButton.count();
    console.log(`   Buttons :has-text("Assistant"): ${count}`);
  }

  if (count > 0) {
    await assistantButton.first().click();
    await page.waitForTimeout(500);
    console.log("   Switched to Assistant view\n");
  } else {
    console.log("   ERROR: Assistant button not found");
    console.log("   Checking if we are on the right page...");

    // Check for tabs
    const tabButtons = await page
      .locator('nav button, [role="tab"]')
      .allTextContents();
    console.log(`   Tab-like elements: ${JSON.stringify(tabButtons)}`);

    await browser.close();
    return false;
  }

  // Continue with tests...
  console.log("5. Verifying ChatPanel is visible...");
  const chatHeader = page.locator("text=Training Assistant");
  await page.waitForTimeout(500);
  if (await chatHeader.isVisible()) {
    console.log("   ChatPanel header visible\n");
  } else {
    console.log("   ERROR: ChatPanel not visible\n");
    await browser.close();
    return false;
  }

  // Test streaming
  console.log("6. Testing streaming (checking for duplicate tokens)...");

  // Check initial state
  const beforeMsgCount = await page.locator(".bg-gray-100").count();
  console.log(`   Messages before send: ${beforeMsgCount}`);

  const textarea = page.locator('textarea[placeholder*="Ask about"]');
  await textarea.fill("Hello");
  await page.locator('button:has-text("Send")').click();

  // Wait briefly and check message count
  await page.waitForTimeout(500);
  const afterSendCount = await page.locator(".bg-gray-100").count();
  console.log(`   Messages after send: ${afterSendCount}`);

  try {
    await page.waitForFunction(
      () => {
        const messages = document.querySelectorAll(".bg-gray-100");
        if (messages.length === 0) return false;
        const lastMsg = messages[messages.length - 1];
        return lastMsg.textContent && lastMsg.textContent.length > 20;
      },
      { timeout: 60000 },
    );
  } catch (e) {
    console.log("   Timeout waiting for response");
  }

  const assistantMessages = await page.locator(".bg-gray-100").all();
  console.log(`   Final message count: ${assistantMessages.length}`);

  // Log each message
  for (let i = 0; i < assistantMessages.length; i++) {
    const text = await assistantMessages[i].textContent();
    console.log(`   Msg[${i}]: "${text?.substring(0, 60)}..."`);
  }

  if (assistantMessages.length > 0) {
    const responseText =
      await assistantMessages[assistantMessages.length - 1].textContent();

    // Check for immediate character-level duplicates
    const hasDuplicatePattern = /(.{10,})\1/.test(responseText);
    console.log(
      `   Duplicate check: ${hasDuplicatePattern ? "FAILED" : "PASSED"}\n`,
    );
  }

  // Test markdown
  console.log("7. Testing markdown rendering...");
  const proseCount = await page.locator(".prose").count();
  console.log(
    `   Prose elements: ${proseCount} - ${proseCount > 0 ? "PASSED" : "FAILED"}\n`,
  );

  // Test no timestamps/sources
  console.log("8. Verifying no timestamps/sources...");
  const pageContent = await page.content();
  const hasTimestamp = /\d{1,2}:\d{2}:\d{2}\s*(AM|PM)?/i.test(pageContent);
  const hasSources = pageContent.includes("Sources:");
  console.log(`   Timestamps: ${hasTimestamp ? "FAILED" : "PASSED"}`);
  console.log(`   Sources: ${hasSources ? "FAILED" : "PASSED"}\n`);

  // Test localStorage
  console.log("9. Testing localStorage persistence...");
  const storageKey = `rllm_chat_messages_${SESSION_ID}`;
  const storedMessages = await page.evaluate(
    (key) => localStorage.getItem(key),
    storageKey,
  );
  console.log(`   localStorage: ${storedMessages ? "PASSED" : "FAILED"}\n`);

  // Test persistence after refresh
  console.log("10. Testing persistence after refresh...");
  await page.reload();
  await page.waitForTimeout(3000); // Just wait for reload instead of networkidle

  assistantButton = page.locator("button").filter({ hasText: /Assistant/i });
  if ((await assistantButton.count()) > 0) {
    await assistantButton.first().click();
    await page.waitForTimeout(1000);
  }

  const messagesAfterRefresh = await page.locator(".bg-gray-100").count();
  console.log(
    `   Messages after refresh: ${messagesAfterRefresh} - ${messagesAfterRefresh > 0 ? "PASSED" : "FAILED"}\n`,
  );

  console.log("=== All tests completed ===");

  await browser.close();
  return true;
}

testChatFeatures().catch(console.error);
