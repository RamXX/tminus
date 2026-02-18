/**
 * Test setup for @tminus/web.
 *
 * Configures jsdom environment and registers jest-dom matchers
 * for asserting on DOM elements (toBeInTheDocument, toHaveTextContent, etc.).
 */
import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
