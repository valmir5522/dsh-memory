"""
md_cg/evidence.py - fix #303 v4 + #277 - Python lado
Alinha com TypeScript src/tools.ts ID_RE = /^[\p{L}\p{N}_\-.@,]{1,128}$/u

GOOD: node-0123, mem_..., 中文节点, a.b@c, a,b, a-b_c
BAD:  ../../, /etc/passwd, sub/dir, has:colon, has%2e%2e, None/null, >128
"""

import re

# Antes (quebrava 中文节点, a.b@c):
# _NODE_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,128}$')

# Depois - aceita unicode \w (letras acentuadas, chinês, etc) + . , @ - 
# \w no Python com UNICODE = [a-zA-Z0-9_ + letras unicode como 中文]
_NODE_ID_RE = re.compile(r'^[\w\-.@,]{1,128}$', re.UNICODE)

_NODE_ID_FORBIDDEN = {'None', 'null', 'none', 'NULL'}

def _is_traversal_like(s: str) -> bool:
    if s in {'.', '..'}:
        return True
    low = s.lower()
    if '..' in low:
        return True
    if '%2e' in low:
        return True
    if '/' in s or '\\' in s:
        return True
    if ':' in s:
        return True
    if '%' in s:  # has%2e%2e
        return True
    return False

def validate_node_id(id_value: str, field_name: str = 'id'):
    """Validação alinhada com TS tools.ts O5 + #277 P1-P6"""
    if id_value is None:
        return
    if not isinstance(id_value, str):
        raise ValueError(f"[{field_name}] tipo errado")
    if id_value in _NODE_ID_FORBIDDEN:
        raise ValueError(f"invalid_node_id: reserved={id_value}")
    if _is_traversal_like(id_value):
        raise ValueError(f"invalid_node_id: traversal={id_value}")
    if not _NODE_ID_RE.match(id_value):
        raise ValueError(f"invalid_node_id: {field_name}={id_value}")

# Compat: mantém nomes antigos se o projeto usava
def is_valid_node_id(id_value: str) -> bool:
    try:
        validate_node_id(id_value)
        return True
    except ValueError:
        return False
