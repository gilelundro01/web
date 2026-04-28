<?php
/**
 * Mengembalikan daftar model yang diizinkan + model default
 * supaya frontend tidak perlu hardcode list model.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    echo json_encode([
        'ok' => false,
        'error' => 'config.php belum dibuat.',
        'models' => new stdClass(),
        'default' => null,
    ]);
    exit;
}

$config = require $configPath;
echo json_encode([
    'ok'      => true,
    'models'  => $config['allowed_models'] ?? new stdClass(),
    'default' => $config['default_model'] ?? null,
]);
