import { TestBed } from "@angular/core/testing";
import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject, firstValueFrom, of, Subject } from "rxjs";

import {
  AccessLeaseSdkService,
  AccessRefreshService,
  AccessRequestSdkService,
} from "@bitwarden/bit-common/pam";
import { ExtendLeaseDialogComponent } from "@bitwarden/bit-common/pam/access-requests/extend-lease-dialog/extend-lease-dialog.component";
import { AccessBadgeTickerService } from "@bitwarden/bit-common/pam/access-state-badge/access-badge-ticker.service";
import { OrganizationService } from "@bitwarden/common/admin-console/abstractions/organization/organization.service.abstraction";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { ConfigService } from "@bitwarden/common/platform/abstractions/config/config.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { CipherViewLike } from "@bitwarden/common/vault/utils/cipher-view-like-utils";
import { DialogService, ToastService } from "@bitwarden/components";

import { RequestAccessDialogComponent } from "../request-access-dialog/request-access-dialog.component";
import { VaultRowAccessStateService } from "../vault-row-access-state/vault-row-access-state.service";

import { BrowserVaultRowAccessService } from "./browser-vault-row-access.service";

describe("BrowserVaultRowAccessService", () => {
  let service: BrowserVaultRowAccessService;
  let state$: BehaviorSubject<unknown>;
  let rowState: MockProxy<VaultRowAccessStateService>;
  let accessRequestSdk: MockProxy<AccessRequestSdkService>;
  let accessLeaseSdk: MockProxy<AccessLeaseSdkService>;
  let accessRefresh: MockProxy<AccessRefreshService>;
  let dialogService: MockProxy<DialogService>;
  let toastService: MockProxy<ToastService>;
  let ticks$: Subject<number>;
  let pamEnabled$: BehaviorSubject<boolean>;

  const gated = { id: "c1", name: "Amazon", partial: true } as unknown as CipherViewLike;
  const normal = { id: "c2", name: "Plain" } as unknown as CipherViewLike;

  const latest = () => firstValueFrom(service.status$(gated));

  beforeEach(() => {
    state$ = new BehaviorSubject<unknown>({ badgeState: "privileged" });
    rowState = mock<VaultRowAccessStateService>();
    rowState.state$.mockReturnValue(state$ as any);
    accessRequestSdk = mock<AccessRequestSdkService>();
    accessLeaseSdk = mock<AccessLeaseSdkService>();
    accessRefresh = mock<AccessRefreshService>();
    dialogService = mock<DialogService>();
    toastService = mock<ToastService>();
    ticks$ = new Subject<number>();
    pamEnabled$ = new BehaviorSubject(true);

    TestBed.configureTestingModule({
      providers: [
        BrowserVaultRowAccessService,
        { provide: ConfigService, useValue: { getFeatureFlag$: () => pamEnabled$ } },
        { provide: AccountService, useValue: { activeAccount$: of({ id: "u1" }) } },
        { provide: OrganizationService, useValue: { organizations$: () => of([]) } },
        { provide: DialogService, useValue: dialogService },
        { provide: VaultRowAccessStateService, useValue: rowState },
        { provide: AccessRequestSdkService, useValue: accessRequestSdk },
        { provide: AccessLeaseSdkService, useValue: accessLeaseSdk },
        { provide: AccessRefreshService, useValue: accessRefresh },
        { provide: AccessBadgeTickerService, useValue: { ticks$ } },
        { provide: ToastService, useValue: toastService },
        { provide: I18nService, useValue: { t: (k: string, p?: string) => (p ? `${k}:${p}` : k) } },
        { provide: LogService, useValue: mock<LogService>() },
      ],
    });
    service = TestBed.inject(BrowserVaultRowAccessService);
  });

  describe("status$", () => {
    it.each([
      ["privileged", "request", "pamRequestToUse"],
      ["pending", "pending", "pamAccessBadgePending"],
      ["unavailable", "unavailable", "pamUnavailableToRequest"],
      ["ready", "ready", "pamAccessBadgeReady"],
    ])("maps the %s badge to the %s row status", async (badge, kind, label) => {
      state$.next({ badgeState: badge });

      expect(await latest()).toEqual({ kind, label, canExtend: false });
    });

    it("counts down an active lease and reports whether it can be extended", async () => {
      state$.next({
        badgeState: { active: { expiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString() } },
        extensionsAllowed: true,
      });

      const status = await latest();

      expect(status?.kind).toBe("active");
      expect(status?.label).toMatch(/^pamAccessBadgeTimeLeft:/);
      expect(status?.canExtend).toBe(true);
    });

    it("re-reads the state once the lease has lapsed", async () => {
      state$.next({
        badgeState: { active: { expiresAt: new Date(Date.now() - 1000).toISOString() } },
      });

      const emissions: unknown[] = [];
      service.status$(gated).subscribe((s) => emissions.push(s));

      expect(emissions).toEqual([]);
      expect(rowState.invalidate).toHaveBeenCalledWith("c1");
    });

    it("reports nothing for an item that is not restricted, without reading its state", async () => {
      expect(await firstValueFrom(service.status$(normal))).toBeNull();
      expect(rowState.state$).not.toHaveBeenCalled();
    });

    it("reports nothing while the Pam flag is off", async () => {
      pamEnabled$.next(false);

      expect(await latest()).toBeNull();
    });
  });

  describe("requestAccess", () => {
    it("opens the request dialog and re-reads the row when a request was made", async () => {
      jest
        .spyOn(RequestAccessDialogComponent, "open")
        .mockReturnValue({ closed: of({ created: true }) } as any);

      await service.requestAccess(gated);

      expect(rowState.invalidate).toHaveBeenCalledWith("c1");
    });

    it("leaves the row alone when the dialog is dismissed", async () => {
      jest
        .spyOn(RequestAccessDialogComponent, "open")
        .mockReturnValue({ closed: of(undefined) } as any);

      await service.requestAccess(gated);

      expect(rowState.invalidate).not.toHaveBeenCalled();
    });
  });

  describe("endAccess", () => {
    beforeEach(() => {
      accessRequestSdk.getCipherAccessState.mockResolvedValue({
        activeLease: { id: "lease-1" },
      } as any);
    });

    it("ends the lease after confirmation and announces the change", async () => {
      dialogService.openSimpleDialog.mockResolvedValue(true);

      await service.endAccess(gated);

      expect(accessLeaseSdk.endLease).toHaveBeenCalledWith("lease-1", { reason: undefined });
      expect(accessRefresh.notifyAccessChanged).toHaveBeenCalledWith("c1");
    });

    it("does nothing when the member declines", async () => {
      dialogService.openSimpleDialog.mockResolvedValue(false);

      await service.endAccess(gated);

      expect(accessLeaseSdk.endLease).not.toHaveBeenCalled();
    });

    it("does nothing without an active lease", async () => {
      accessRequestSdk.getCipherAccessState.mockResolvedValue({ activeLease: undefined } as any);

      await service.endAccess(gated);

      expect(dialogService.openSimpleDialog).not.toHaveBeenCalled();
    });
  });

  describe("extendAccess", () => {
    beforeEach(() => {
      accessRequestSdk.getCipherAccessState.mockResolvedValue({
        activeLease: { id: "lease-1" },
      } as any);
    });

    it("extends the lease with the dialog's request", async () => {
      const request = { durationSeconds: 900, reason: "audit" };
      jest
        .spyOn(ExtendLeaseDialogComponent, "open")
        .mockReturnValue({ closed: of(request) } as any);
      accessLeaseSdk.extendLease.mockResolvedValue({ status: "approved" } as any);

      await service.extendAccess(gated);

      expect(accessLeaseSdk.extendLease).toHaveBeenCalledWith("lease-1", request);
      expect(toastService.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "success", message: "pamExtendLeaseSuccess" }),
      );
      expect(accessRefresh.notifyAccessChanged).toHaveBeenCalledWith("c1");
    });

    it("warns when the extension is denied", async () => {
      jest
        .spyOn(ExtendLeaseDialogComponent, "open")
        .mockReturnValue({ closed: of({ durationSeconds: 900, reason: "r" }) } as any);
      accessLeaseSdk.extendLease.mockResolvedValue({ status: "denied" } as any);

      await service.extendAccess(gated);

      expect(toastService.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "warning", message: "pamExtendLeaseEnded" }),
      );
    });

    it("does nothing when the dialog is dismissed", async () => {
      jest
        .spyOn(ExtendLeaseDialogComponent, "open")
        .mockReturnValue({ closed: of(undefined) } as any);

      await service.extendAccess(gated);

      expect(accessLeaseSdk.extendLease).not.toHaveBeenCalled();
    });
  });

  describe("startAccess", () => {
    it("does nothing without an approved request", async () => {
      accessRequestSdk.getCipherAccessState.mockResolvedValue({ badgeState: "ready" } as any);

      await service.startAccess(gated);

      expect(accessRequestSdk.activateAccessRequest).not.toHaveBeenCalled();
    });
  });
});
