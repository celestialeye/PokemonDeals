# Screenshot Evidence Index

Images 1–14 were attached during the original automation session and are preserved as operational evidence, with original temporary filenames for traceability. The separately dated live-browser captures below were produced by the bounded challenge diagnostic, not the local fixtures.

1. [Initial Target high-demand modal](./01-target-high-demand-initial.png)  
   Original: `copilot-image-ee575e.png`. Shows `High-demand item in your cart`, explanatory text, and an OK button.

2. [Target item-not-added dialog](./02-target-item-not-added.png)  
   Original: `copilot-image-015e25.png`. Shows `Item not added to cart`, a close icon, Continue shopping, and View cart & check out.

3. [Target checkout with high-demand overlay](./03-target-checkout-high-demand-overlay.png)  
   Original: `copilot-image-1aed41.png`. Shows populated checkout details behind the high-demand modal.

4. [Target shipping throttling error](./04-target-shipping-throttled-save-continue.png)  
   Original: `copilot-image-34fba6.png`. Shows `Request throttled due to high demand item` and Save and continue.

5. [Target high-demand OK dialog](./05-target-high-demand-ok.png)  
   Original: `copilot-image-90acb9.png`. Shows the high-demand modal during shipping-address processing.

6. [Target PIN confirmation](./06-target-pin-confirmation.png)  
   Original: `copilot-image-dc0ade.png`. Shows Confirm your PIN, a masked PIN field, and Confirm.

7. [Target high-demand dialog after PIN](./07-target-high-demand-after-pin.png)  
   Original: `copilot-image-8ed17a.png`. Shows the high-demand modal over the order-review page.

8. [Target Place your order button](./08-target-place-your-order.png)  
   Original: `copilot-image-61c270.png`. Establishes the exact button label used by Target.

9. [Target checkout-busy modal](./09-target-checkout-busy-modal.png)  
   Original: `copilot-image-4d85a6.png`. Shows `Checkout is busy right now`, explanatory text, and an OK button.

10. [Target checkout-busy inline banner](./10-target-checkout-busy-banner.png)  
    Original: `copilot-image-f461ea.png`. Shows the same busy message as a non-modal banner with no OK button.

11. [Amazon quantity-unavailable page with two items](./11-amazon-quantity-unavailable-two-items.png)  
    Original: `copilot-image-298355.png`. Shows quantity zero and the item-update error for two products.

12. [Amazon quantity-unavailable page](./12-amazon-quantity-unavailable.png)  
    Original: `copilot-image-6eafd4.png`. Shows the same quantity-zero condition later in the checkout flow.

13. [Later Target high-demand modal](./13-target-high-demand-modal-later.png)  
    Original: `copilot-image-393ef3.png`. Shows another high-demand modal during payment/order review.

14. [Later Target high-demand dialog after PIN](./14-target-high-demand-after-pin-later.png)  
    Original: `copilot-image-bd79a1.png`. Shows the repeated high-demand modal before Place your order.

## Live Target challenge evidence (2026-09-18)

15. [First isolated live challenge](./target-live-hold-2026-09-18T19-37-28-255Z-before.png) and [unchanged after control-discovery failure](./target-live-hold-2026-09-18T19-37-28-255Z-after.png). Real Target `Quick verification / Press & hold` modal after one product navigation in an unauthenticated, nonstandard-user-agent session. No pointer input was issued in this attempt. Reference identifier redacted.

16. [Preserved diagnostic challenge](./target-live-hold-diagnostic-before.png) and [immediately before native hold](./target-live-hold-diagnostic-pre-hold.png). Second isolated session, after the failure cooldown; actionable iframe was found inside a closed shadow root. Cropped above the reference identifier.

17. [Processing after the automatic hold](./target-live-hold-diagnostic-after-hold.png). The hold ran for approximately 10 seconds, but the provider was still processing at the original settle check. The monitor reported `unresolved`; this screenshot is not a successful-solve claim.

18. [Later read-only clearance observation](./target-live-hold-diagnostic-settled.png). Normal product page at 19:46:53Z, with no intervening pointer input or navigation after the hold. Location information redacted.

19. [Product page after fresh successful polling](./target-live-hold-fresh-poll.png). Same recovered session after a fresh product load and HTTP 200 availability poll at 19:52:01Z. Location information masked/cropped. The network result is recorded in `TARGET-CHALLENGE-TRIGGER-EVIDENCE.md`; the image alone establishes only visible page state.

20. [Revised-solver live confirmation report](./target-live-confirmation-2026-09-18T19-58-58-091Z.json). One fresh unauthenticated session at ~19:59Z returned HTTP 200 without a challenge, including five subsequent read-only checks. Outcome: `not_exercised_no_challenge`; zero solver input or replayed API polls. This report does not close the same-run recovery gate.

21. Automation-signal trial: [report](./target-live-automation-signal-2026-09-18T20-04-55-751Z.json), [before](./target-live-automation-signal-2026-09-18T20-04-55-751Z-before.png), and [after](./target-live-automation-signal-2026-09-18T20-04-55-751Z-unresolved.png). With Chrome automation enabled, one navigation presented the challenge. One native attempt ended in **`Please try again`** and backoff; this is a failed solve.

22. **Passing same-run retry:** [report](./target-live-retry-refresh-2026-09-18T20-11-28-193Z.json), [before retry](./target-live-retry-refresh-2026-09-18T20-11-28-193Z-attempt-1-before.png), [after native recovery](./target-live-retry-refresh-2026-09-18T20-11-28-193Z-attempt-1-after.png), and [final stable product page](./target-live-retry-refresh-2026-09-18T20-11-28-193Z-final.png). Retrying the preserved page succeeded on the first attempt, with no challenge refresh. The real driver emitted `TARGET_CHALLENGE_CLEARED` and `TARGET_CHALLENGE_SOLVED`, followed by two valid HTTP 200 polls. Exactly one pointer-down/up pair and no purchase actions were issued. The test used a 45-second attempt budget in an isolated unauthenticated session. An extra transient unreadable inspection is retained in the report; the subsequent inspections and two API responses confirmed recovery.

No account credentials, payment data, cookies, or challenge tokens are included. The earlier captures (15–19) did **not** establish the same-run monitor sequence, but the later report/captures in entry 22 do. That passing diagnostic does not prove default-timeout performance, the unexercised refresh fallback, or normal authenticated-session reliability.

## Verification evidence boundary

The original attached image set (1–14) does not contain a screenshot of the earlier Target verification incident. Session messages record verification after rapid preorder activity but do not preserve enough visual evidence to identify that incident's provider or exact challenge type. The dated diagnostic captures (15–19 and 21–22) establish separate live press-and-hold occurrences and must not be used to retroactively identify the original incident.

The scripts therefore detect a conservative set of challenge indicators, including CAPTCHA, robot check, Press and hold, security check, blocked, verify, and access denied. These are detection patterns, not proof that every listed challenge type was observed.

The incident occurred after repeated Preorder clicks, first reported around 1:44 AM local time and reported again around 1:47 AM. The supported resolution is to pause the affected worker, complete the challenge manually in Chrome, verify that the normal Target page has returned, and resume that worker at a conservative cadence. Unaffected Target workers may continue. The legacy workers retain manual handling. The Target URL watch now has an optional bounded native press-and-hold solver; it must still pause/back off when independent verification does not confirm clearance. See the separate live evidence above for its current limitations.
