<?php
/**
 * Mengembalikan daftar model yang diizinkan + model default
 * supaya frontend tidak perlu hardcode list model.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$config = load_config(__DIR__);

echo json_encode([
    'ok'      => true,
    'models'  => $config['allowed_models'] ?? new stdClass(),
    'default' => $config['default_model'] ?? null,
]);
