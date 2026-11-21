# Product

<!-- impeccable:product-schema 1 -->

## Platform

android

## Stack

Expo and React Native with TypeScript, a local Kotlin Expo module, and an EAS release APK. One Cloudflare Worker uses D1 and a private R2 Standard bucket. The desktop publisher also runs in CI.

## Users

One app owner publishes signed standalone APKs and manages their own apps on an Android phone.

## Product Purpose

Payload makes it possible to find available updates, review release details, and install or update through Android’s system installer.

## Capabilities and Constraints

One release channel. Installs are user-initiated. The current APK stays available and its replacement starts a 30-day retention period. Package visibility depends on the IDs built into Payload.

## Evidence on Hand

The requirements document supplies the product decisions. App names, app icons, and release notes come from the owner’s releases.

## Accessibility & Inclusion

Support one-handed use, Android font scaling, TalkBack, and standard Android navigation.
