"""健管师名册：manager -> 多个 patient（被监测用户）。

私有名册：所有读写都带 manager 作用域，越权返回 None / 不命中。
CGM 数据按 patient 的 sino_user_id 作为 owner 存取。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from health.db import db_exec, db_query


@dataclass
class Patient:
    id: str
    manager: str
    sino_user_id: str | None
    phone: str | None
    display_name: str | None
    enabled: bool


def _row_to_patient(row: dict[str, Any]) -> Patient:
    return Patient(
        id=row["id"],
        manager=row["manager"],
        sino_user_id=row.get("sino_user_id"),
        phone=row.get("phone"),
        display_name=row.get("display_name"),
        enabled=bool(row.get("enabled", True)),
    )


def list_patients(manager: str, enabled_only: bool = False) -> list[Patient]:
    sql = """
        SELECT id, manager, sino_user_id, phone, display_name, enabled
        FROM health.patients
        WHERE manager = %s
    """
    if enabled_only:
        sql += " AND enabled = true"
    sql += " ORDER BY created_at"
    return [_row_to_patient(r) for r in db_query(sql, (manager,))]


def get_patient(manager: str, patient_id: str) -> Patient | None:
    rows = db_query(
        """
        SELECT id, manager, sino_user_id, phone, display_name, enabled
        FROM health.patients
        WHERE manager = %s AND id = %s
        """,
        (manager, patient_id),
    )
    return _row_to_patient(rows[0]) if rows else None


def find_patient_by_sino(manager: str, sino_user_id: str) -> Patient | None:
    rows = db_query(
        """
        SELECT id, manager, sino_user_id, phone, display_name, enabled
        FROM health.patients
        WHERE manager = %s AND sino_user_id = %s
        """,
        (manager, sino_user_id),
    )
    return _row_to_patient(rows[0]) if rows else None


def upsert_patient(
    manager: str,
    *,
    sino_user_id: str,
    phone: str | None = None,
    display_name: str | None = None,
    enabled: bool = True,
) -> Patient:
    """按 (manager, sino_user_id) 去重 upsert，返回最新记录。"""
    existing = find_patient_by_sino(manager, sino_user_id)
    pid = existing.id if existing else f"p_{uuid.uuid4().hex[:16]}"
    db_exec(
        """
        INSERT INTO health.patients
            (id, manager, sino_user_id, phone, display_name, enabled, updated_at)
        VALUES (%s, %s, %s, %s, %s, %s, now())
        ON CONFLICT (manager, sino_user_id) DO UPDATE SET
            phone = COALESCE(EXCLUDED.phone, health.patients.phone),
            display_name = COALESCE(EXCLUDED.display_name, health.patients.display_name),
            enabled = EXCLUDED.enabled,
            updated_at = now()
        """,
        (pid, manager, sino_user_id, phone, display_name, enabled),
    )
    p = find_patient_by_sino(manager, sino_user_id)
    assert p is not None
    return p


def delete_patient(manager: str, patient_id: str) -> bool:
    """仅删名册行，不删历史 CGM 数据。返回是否命中。"""
    if not get_patient(manager, patient_id):
        return False
    db_exec(
        "DELETE FROM health.patients WHERE manager = %s AND id = %s",
        (manager, patient_id),
    )
    return True


def resolve_owner_for_patient(manager: str, patient_id: str) -> str | None:
    """返回 patient 的 CGM owner（= sino_user_id），越权或无绑定返回 None。"""
    p = get_patient(manager, patient_id)
    if not p or not p.sino_user_id:
        return None
    return p.sino_user_id.strip()
