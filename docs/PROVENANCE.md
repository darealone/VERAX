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

## Open points to settle before publishing or selling

- [x] **Earlier concept material.** The author created the concept pages this project builds on (SIGNAL, ANTERA, PARALLAX; this project started under the working name SIGNAL) in October and November 2026, after the employment had ended. They are the author's own work and may be reused. Keep dated copies of them, for example in their own repositories, as a record.
- [ ] **Post-employment obligations.** Read the employment contract and any termination or settlement agreement. Look for confidentiality clauses, post-contractual non-compete clauses and IP clauses. Under German law, a post-contractual non-compete is generally only binding if compensation (Karenzentschädigung) is paid (§§ 74 ff. HGB). Trade secrets stay protected after employment ends (GeschGehG). Have a lawyer confirm this for your situation.
- [ ] **Name.** The working name SIGNAL was dropped because of likely conflicts (for example the Signal messenger). The product is now called VERAX MERIDIAN. "Verax" on its own is already used by several companies, including Verax AI (AI governance software). Before public use, have the two-part name searched (DPMA, EUIPO, USPTO) in the relevant software classes (Nice 9 and 42). The name lives in `package.json`, the README files and `org.productName`.
- [ ] **License.** Apache-2.0 lets anyone use, modify and sell this code once it is published. Decide on the license before the first public push: open source, source-available or proprietary. As the sole author, you can still change it at that point.
- [ ] **AI-assisted code.** Copyright protection for purely machine-generated output is limited in many jurisdictions. Your creative direction, selection and edits are what make the work yours. Keep making substantive changes of your own, and keep the commit history.
- [ ] **Identity.** Make commits under a private, stable identity (not an employer account). The dated history then documents independent creation.
