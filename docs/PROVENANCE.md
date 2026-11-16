# Provenance and ownership

This file is a factual record of where this codebase comes from. It is not legal advice.

## Origin

- Written from scratch, starting November 2026, after the author's previous employment had ended. The first commit in this repository marks the start.
- It is based on a generic, publicly describable idea: before something goes live, prove that its dependencies work, require a named approval, and keep an audit trail.
- No source code, documents, data, configurations, screenshots, customer information or internal terminology from any former employer or client was used or consulted.
- No code was copied from earlier concept pages or prototypes. The implementation, data model and UI are new.
- All sample data is fictional and uses reserved domains (`example.com`, `example.test`).
- The project has no runtime dependencies beyond the Node.js standard library. No third-party code is bundled. The Apache-2.0 license text in `LICENSE` is the standard text published by the Apache Software Foundation.
- The check types (HTTP reachability, JSON assertions, synthetic round-trip records, manual attestation) are common, publicly documented testing techniques.
- Parts of the code were drafted with an AI coding assistant, directed and reviewed by the author. Commits made with its help say so in a `Co-Authored-By` line.

## Relationship to earlier work

- While employed, the author built a separate internal tool for a former employer. It addressed a similar problem: checking launch readiness before a campaign goes live. That tool, its code, documents, data and internal specifics belong to the former employer and are not part of this project.
- This project was started from scratch after the employment ended, under a new name, with a new codebase, a new data model and a new UI. It was written without access to, and without reference to, the former tool's code, documents, data or configurations.
- What carries over is the author's general professional experience and skill: knowing that handover chains break, that approvals must be traceable, and that checks must be reproducible. These are widely known practices, not trade secrets of any employer.

## Open points to settle before publishing or selling

- [x] **Earlier concept material.** The author created the concept pages this project builds on (SIGNAL, ANTERA, PARALLAX; this project started under the working name SIGNAL) in October and November 2026, after the employment had ended. They are the author's own work and may be reused. ANTERA and PARALLAX are kept in the author's private repository `darealone/aether-hive`, first pushed on 6 November 2026.
- [ ] **No former-employer material on your devices.** If any files from the internal tool (code, specs, exports, screenshots) are still on your devices or in your accounts, do not open them while working on this project. Check whether your contract requires you to return or delete them, and do that, keeping a dated note of it.
- [ ] **Post-employment obligations.** Read the employment contract and any termination or settlement agreement. Look for confidentiality clauses, post-contractual non-compete clauses and IP clauses. Under German law, a post-contractual non-compete is generally only binding if compensation (Karenzentschädigung) is paid (§§ 74 ff. HGB). Trade secrets stay protected after employment ends (GeschGehG). Have a lawyer confirm this for your situation.
- [ ] **Name.** The working name SIGNAL was dropped because of likely conflicts (for example the Signal messenger). The product is now called VERAX MERIDIAN. "Verax" on its own is already used by several companies, including Verax AI (AI governance software). Before public use, have the two-part name searched (DPMA, EUIPO, USPTO) in the relevant software classes (Nice 9 and 42). The name lives in `package.json`, the README files and `org.productName`.
- [ ] **License.** Apache-2.0 lets anyone use, modify and sell this code once it is published. Decide on the license before the first public push: open source, source-available or proprietary. As the sole author, you can still change it at that point.
- [ ] **AI-assisted code.** Copyright protection for purely machine-generated output is limited in many jurisdictions. Your creative direction, selection and edits are what make the work yours. Keep making substantive changes of your own, and keep the commit history.
- [ ] **Identity.** Make commits under a private, stable identity (not an employer account). The dated history then documents independent creation.
